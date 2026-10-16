import pool from './db.js';

/**
 * Internal migration primitive only. Never mount as a public API.
 * The reviewer must independently validate subscriber ownership using
 * Dodo's merchant-side records AND subscriber-mediated evidence.
 * An email match, receipt ID or localStorage userId alone is insufficient.
 *
 * No Dodo API key or subscriber e-mail is included in the migration record.
 * Does not change premium_expires or call Dodo APIs.
 */
export async function linkLegacyPremiumAfterReview(input, verifyEvidence, database = pool) {
    const { issuer, subject, legacyUserId, reviewedBy, proofMethod, evidenceReference } = input || {};
    for (const value of [issuer, subject, legacyUserId, reviewedBy, proofMethod, evidenceReference]) {
        if (typeof value !== 'string' || value.length < 3 || value.length > 512) {
            throw new Error('Missing/invalid signed migration review details');
        }
    }
    if (!['dodo_merchant_manually_verified'].includes(proofMethod)) {
        throw new Error('Unsupported Dodo ownership review method');
    }
    if (typeof verifyEvidence !== 'function') {
        throw new Error('Independent Dodo ownership verification required');
    }
    // The provided callback must query trusted evidence, not a client-supplied claim.
    // No migration is possible without a verified customer identity returned by it.
    const proof = await verifyEvidence({ issuer, subject, legacyUserId, proofMethod, evidenceReference });
    if (!proof || proof.verified !== true ||
        proof.evidenceReference !== evidenceReference ||
        !/^dodo-audit:clm_[a-f0-9]{32,100}$/.test(proof.evidenceReference) ||
        typeof proof.dodoCustomerId !== 'string' ||
        !/^cus_[A-Za-z0-9_-]{5,120}$/.test(proof.dodoCustomerId) ||
        typeof proof.paidThrough !== 'string' ||
        !Number.isFinite(new Date(proof.paidThrough).getTime())) {
        throw new Error('Independent Dodo customer ownership not verified');
    }

    const db = await database.connect();
    let started = false;
    try {
        await db.query('BEGIN');
        started = true;
        // Lock the auth identity and the target subscriber deterministically.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [issuer,subject]);
        const legacy = await db.query(
            'SELECT id,dodo_customer_id,premium_expires FROM users WHERE id=$1 FOR UPDATE',
            [legacyUserId]
        );
        if (legacy.rowCount !== 1 || legacy.rows[0].dodo_customer_id !== proof.dodoCustomerId ||
            !legacy.rows[0].premium_expires) {
            throw new Error('Legacy subscriber does not match verified Dodo customer');
        }
        const mapped = await db.query(
            'SELECT user_id FROM auth_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE',
            [issuer,subject]
        );
        if (mapped.rowCount !== 1) throw new Error('Verified account has not been initialized');
        const currentUserId = mapped.rows[0].user_id;
        const priorClaim = await db.query(
            'SELECT issuer,subject,evidence_reference FROM legacy_account_claims WHERE legacy_user_id=$1',
            [legacyUserId]
        );
        if (priorClaim.rowCount) {
            const same = priorClaim.rows[0].issuer === issuer && priorClaim.rows[0].subject === subject;
            if (!same || currentUserId !== legacyUserId) throw new Error('Legacy subscriber is already claimed');
            await db.query('COMMIT');
            started = false;
            return { userId: legacyUserId, alreadyLinked: true };
        }
        if (currentUserId === legacyUserId) {
            throw new Error('Authenticated identity already mapped without an audit trail');
        }
        const placeholder = await db.query(
            'SELECT premium_expires,dodo_customer_id FROM users WHERE id=$1 FOR UPDATE',
            [currentUserId]
        );
        if (placeholder.rowCount !== 1 || placeholder.rows[0].premium_expires ||
            placeholder.rows[0].dodo_customer_id) {
            throw new Error('New account already has entitlements; manual reconciliation required');
        }
        const paid = await db.query('SELECT 1 FROM payments WHERE user_id=$1 LIMIT 1',[currentUserId]);
        if (paid.rowCount) throw new Error('New account has payments; manual reconciliation required');

        // The claim audit insertion must succeed before binding the legacy ID.
        await db.query(
            `INSERT INTO legacy_account_claims
            (legacy_user_id,issuer,subject,dodo_customer_id,evidence_reference,proof_method,reviewed_by,previous_user_id,premium_expires_at_claim)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [legacyUserId,issuer,subject,proof.dodoCustomerId,evidenceReference,proofMethod,reviewedBy,currentUserId,legacy.rows[0].premium_expires]
        );
        await db.query(
            'UPDATE auth_identities SET user_id=$1 WHERE issuer=$2 AND subject=$3',
            [legacyUserId,issuer,subject]
        );
        await db.query('COMMIT');
        started = false;
        return { userId: legacyUserId, alreadyLinked: false };
    } catch (error) {
        if (started) {
            try { await db.query('ROLLBACK'); } catch (e) {
                console.error('Legacy claim rollback failed:',e);
            }
        }
        throw error;
    } finally {
        db.release();
    }
}
