import pool from './db.js';

/**
 * INTERNAL OPERATOR ONLY: reverse one newly linked legacy Premium identity.
 * Never expose as a public route, cron job, or unauthenticated admin endpoint.
 *
 * The original claim and all payment/entitlement records are RETAINED.
 * Only the verified Neon identity's user_id is restored to the captured
 * pre-claim placeholder, and a durable, one-time reversal audit is inserted.
 *
 * Authorization MUST come from a trusted operator review implementation.
 * Caller-supplied IDs, emails, browser flags or an expired OTP do not authorize
 * a reversal. The production caller is deliberately NOT implemented.
 */
export async function reverseLegacyPremiumClaimAfterReview(
    input, authorizeRollback, database = pool, now = new Date()
) {
    const {
        issuer, subject, legacyUserId, originalEvidenceReference,
        reviewedBy, reason
    } = input || {};
    const validText = (s,min,max) =>
        typeof s === 'string' && s.trim().length >= min && s.length <= max;
    if(!validText(issuer,8,512) || !issuer.startsWith('https://') ||
       !validText(subject,3,255) || !validText(legacyUserId,3,512) ||
       !/^dodo-audit:clm_[a-f0-9]{40}$/.test(originalEvidenceReference||'') ||
       !validText(reviewedBy,3,128) || !validText(reason,12,500) ||
       typeof authorizeRollback !== 'function' ||
       !(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw Error('ROLLBACK_INVALID_OPERATOR_REQUEST');
    }

    // The callback must be implemented by a separately authenticated,
    // operator-only process; no success-only callback may be exposed to users.
    const review = await authorizeRollback({
        issuer,subject,legacyUserId,originalEvidenceReference,reviewedBy,reason
    });
    if(review?.authorized !== true ||
       review.issuer !== issuer || review.subject !== subject ||
       review.legacyUserId !== legacyUserId ||
       review.originalEvidenceReference !== originalEvidenceReference ||
       review.reviewedBy !== reviewedBy) {
        throw Error('ROLLBACK_OPERATOR_AUTHORIZATION_REQUIRED');
    }

    const db = await database.connect();
    let inTransaction = false;
    try {
        await db.query('BEGIN');
        inTransaction = true;
        // Match the forward claim lock so linking/reversing this identity
        // cannot race each other on a concurrent operator request.
        await db.query(
            'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
            [issuer,subject]
        );
        const c = await db.query(
            'SELECT issuer,subject,evidence_reference,dodo_customer_id,'+
            'previous_user_id,premium_expires_at_claim,premium_expires_after_claim,reviewed_at '+
            'FROM legacy_account_claims WHERE legacy_user_id=$1 FOR UPDATE',
            [legacyUserId]
        );
        const claim=c.rows[0];
        if(c.rowCount!==1 || claim.issuer!==issuer || claim.subject!==subject ||
           claim.evidence_reference!==originalEvidenceReference ||
           !validText(claim.previous_user_id,3,512) ||
           !claim.premium_expires_at_claim || !claim.premium_expires_after_claim ||
           !claim.reviewed_at) {
            throw Error('ROLLBACK_ORIGINAL_CLAIM_OR_SNAPSHOT_MISMATCH');
        }
        const claimTime=new Date(claim.reviewed_at).getTime();
        if(!Number.isFinite(claimTime) ||
           now.getTime()<claimTime ||
           now.getTime()-claimTime>24*60*60*1000) {
            throw Error('ROLLBACK_WINDOW_EXPIRED_MANUAL_RECONCILIATION_REQUIRED');
        }
        const already=await db.query(
            'SELECT 1 FROM legacy_account_claim_reversals WHERE legacy_user_id=$1',
            [legacyUserId]
        );
        if(already.rowCount) throw Error('ROLLBACK_ALREADY_REVERSED');

        const legacy=await db.query(
            'SELECT dodo_customer_id,premium_expires FROM users WHERE id=$1 FOR UPDATE',
            [legacyUserId]
        );
        const expiry=legacy.rows[0]?.premium_expires;
        if(legacy.rowCount!==1 ||
           legacy.rows[0].dodo_customer_id!==claim.dodo_customer_id ||
           !expiry ||
           new Date(expiry).getTime()!==new Date(claim.premium_expires_after_claim).getTime() ||
           new Date(claim.premium_expires_at_claim).getTime()>
               new Date(claim.premium_expires_after_claim).getTime()) {
            throw Error('ROLLBACK_PREMIUM_OR_BILLING_CHANGED_MANUAL_REVIEW');
        }

        const current=await db.query(
            'SELECT user_id FROM auth_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE',
            [issuer,subject]
        );
        if(current.rowCount!==1 || current.rows[0].user_id!==legacyUserId)
            throw Error('ROLLBACK_IDENTITY_MAPPING_CONFLICT');

        const original=await db.query(
            'SELECT id,premium_expires,dodo_customer_id FROM users WHERE id=$1 FOR UPDATE',
            [claim.previous_user_id]
        );
        if(original.rowCount!==1 || original.rows[0].premium_expires ||
           original.rows[0].dodo_customer_id)
            throw Error('ROLLBACK_ORIGINAL_PLACEHOLDER_CHANGED');
        const [otherIdentity,placeholderCharges,postClaimCharges]=await Promise.all([
            db.query('SELECT 1 FROM auth_identities WHERE user_id=$1 LIMIT 1',[claim.previous_user_id]),
            db.query('SELECT 1 FROM payments WHERE user_id=$1 LIMIT 1',[claim.previous_user_id]),
            db.query('SELECT 1 FROM payments WHERE user_id=$1 AND created_at>=$2 LIMIT 1',
                [legacyUserId,claim.reviewed_at])
        ]);
        if(otherIdentity.rowCount || placeholderCharges.rowCount || postClaimCharges.rowCount)
            throw Error('ROLLBACK_NEW_ACTIVITY_REQUIRES_MANUAL_RECONCILIATION');

        // Insertion and identity restoration are all-or-nothing. The original
        // forward claim row is intentionally retained, not erased or rewritten.
        await db.query(
            'INSERT INTO legacy_account_claim_reversals '+
            '(legacy_user_id,previous_user_id,issuer,subject,original_evidence_reference,reviewed_by,reason) '+
            'VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [legacyUserId,claim.previous_user_id,issuer,subject,
                originalEvidenceReference,reviewedBy,reason]
        );
        const restored=await db.query(
            'UPDATE auth_identities SET user_id=$1 '+
            'WHERE issuer=$2 AND subject=$3 AND user_id=$4 RETURNING user_id',
            [claim.previous_user_id,issuer,subject,legacyUserId]
        );
        if(restored.rowCount!==1) throw Error('ROLLBACK_CONCURRENT_IDENTITY_CHANGE');
        await db.query('COMMIT');
        inTransaction=false;
        return Object.freeze({
            reverted:true,legacyUserId,restoredUserId:claim.previous_user_id
        });
    } catch(error) {
        if(inTransaction) {
            try { await db.query('ROLLBACK'); }
            catch { console.error('ROLLBACK_DATABASE_TRANSACTION_RECOVERY_FAILED'); }
        }
        throw error;
    } finally {
        db.release();
    }
}
