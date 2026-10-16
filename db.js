import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { runWebhookTransaction } from './webhook-transaction.js';
const { Pool } = pg;

// Verify the server certificate. Only allow opt-out for explicitly configured legacy hosts.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: process.env.DB_ALLOW_SELF_SIGNED === 'true' ? false : true },
    max: 5
});

export async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        dodo_customer_id TEXT,
        premium_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        dodo_payment_id TEXT,
        amount NUMERIC,
        currency TEXT,
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        processed_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_identities (
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (issuer, subject)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS legacy_account_claims (
        legacy_user_id TEXT PRIMARY KEY REFERENCES users(id),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        dodo_customer_id TEXT NOT NULL,
        evidence_reference TEXT NOT NULL UNIQUE,
        proof_method TEXT NOT NULL,
        reviewed_by TEXT NOT NULL,
        reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        previous_user_id TEXT REFERENCES users(id),
        premium_expires_at_claim TIMESTAMPTZ,
        UNIQUE (issuer, subject)
    )`);
    // Non-destructive addition for already-existing schemas. Historical claims
    // without a snapshot cannot be automatically reversed.
    await pool.query('ALTER TABLE legacy_account_claims ADD COLUMN IF NOT EXISTS previous_user_id TEXT REFERENCES users(id)');
    await pool.query('ALTER TABLE legacy_account_claims ADD COLUMN IF NOT EXISTS premium_expires_at_claim TIMESTAMPTZ');
    await pool.query('ALTER TABLE legacy_account_claims ADD COLUMN IF NOT EXISTS premium_expires_after_claim TIMESTAMPTZ');
    await pool.query('ALTER TABLE legacy_account_claims ADD COLUMN IF NOT EXISTS operator_approval_reference TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_claim_approval ON legacy_account_claims(operator_approval_reference) WHERE operator_approval_reference IS NOT NULL');
    await pool.query(`CREATE TABLE IF NOT EXISTS legacy_account_claim_reversals (
        legacy_user_id TEXT PRIMARY KEY REFERENCES legacy_account_claims(legacy_user_id),
        previous_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        original_evidence_reference TEXT NOT NULL,
        reviewed_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        reversed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Signed Dodo refund/dispute notices must not disappear into an "ignored"
    // handler. This audit is event-level evidence, not permission to revoke an
    // independently renewed customer. No secrets, card details or full payloads.
    await pool.query(`CREATE TABLE IF NOT EXISTS payment_risk_events (
        webhook_id TEXT PRIMARY KEY REFERENCES webhook_events(id),
        event_type TEXT NOT NULL,
        provider_record_id TEXT NOT NULL,
        dodo_payment_id TEXT NOT NULL,
        dodo_customer_id TEXT,
        matched_payment_user_id TEXT REFERENCES users(id),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        review_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (review_status IN ('pending','reviewed'))
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_payment_risk_lookup ON payment_risk_events(dodo_payment_id,received_at DESC)');
    // OTP challenge is bound to a verified auth identity AND Dodo billing customer.
    // Store only a keyed digest, never the plaintext OTP.
    await pool.query(`CREATE TABLE IF NOT EXISTS billing_email_challenges (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        code_digest TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        consumed_at TIMESTAMPTZ,
        attempts INT NOT NULL DEFAULT 0,
        CHECK (attempts >= 0 AND attempts <= 5)
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_billing_challenge_identity ON billing_email_challenges(issuer,subject,created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_dodo_customer ON users(dodo_customer_id)');
    // A second durable constraint independent of the deterministic payment record ID.
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_dodo_id ON payments(dodo_payment_id) WHERE dodo_payment_id IS NOT NULL');
    if(process.env.APP_ENV==='staging') {
        await pool.query(`CREATE TABLE IF NOT EXISTS staging_mail_tests (
            issuer TEXT NOT NULL,
            subject TEXT NOT NULL,
            requested_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (issuer,subject)
        )`);
    }
    console.log('✅ DB initialized');
}


/**
 * Create or resolve an account from a CRYPTOGRAPHICALLY VERIFIED provider identity.
 * This function is never called with localStorage userId. A per-identity transaction
 * lock ensures concurrent logins do not create orphan users. Legacy Premium accounts
 * are intentionally NOT silently linked by email or browser-supplied IDs.
 */
export async function getAccountUserId({ issuer, subject }) {
    if (typeof issuer !== 'string' || !issuer || issuer.length > 512 ||
        typeof subject !== 'string' || !subject || subject.length > 255) {
        throw new Error('Invalid verified identity');
    }
    const client = await pool.connect();
    let active = false;
    try {
        await client.query('BEGIN');
        active = true;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [issuer, subject]);
        const existing = await client.query(
            'SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2',
            [issuer, subject]
        );
        if (existing.rows.length) {
            await client.query('COMMIT');
            active = false;
            return existing.rows[0].user_id;
        }
        const userId = 'u_' + randomBytes(24).toString('hex');
        await client.query('INSERT INTO users (id) VALUES ($1)', [userId]);
        await client.query(
            'INSERT INTO auth_identities (issuer, subject, user_id) VALUES ($1, $2, $3)',
            [issuer, subject, userId]
        );
        await client.query('COMMIT');
        active = false;
        return userId;
    } catch (error) {
        if (active) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Identity transaction rollback failed:', rollbackError);
            }
        }
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Trusted Neon Auth email/ban status, never read from browser flags.
 * Only call after JWT signature and issuer have been verified.
 */
export async function isVerifiedNeonAuthSubject(subject, db = pool) {
    if (typeof subject !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(subject)) return false;
    const result = await db.query(
        'SELECT "emailVerified" AS verified FROM neon_auth."user" WHERE id = $1::uuid AND COALESCE(banned, false) = false',
        [subject]
    );
    return result.rows.length === 1 && result.rows[0].verified === true;
}

export async function getPremiumStatus(userId) {
    const result = await pool.query('SELECT premium_expires FROM users WHERE id = $1', [userId]);
    const raw = result.rows[0]?.premium_expires;
    const expires = raw ? new Date(raw) : null;
    const valid = expires && Number.isFinite(expires.getTime());
    return {
        premium: Boolean(valid && expires > new Date()),
        expiresAt: valid ? expires.toISOString() : null
    };
}

export async function isPremiumUser(userId) {
    return (await getPremiumStatus(userId)).premium;
}

// `db` can be a transaction client, so updating Premium and recording a webhook are atomic.
export async function setPremium(userId, expiresAt, email = null, dodoCustomerId = null, db = pool) {
    let expires;
    if (expiresAt instanceof Date) expires = expiresAt;
    else if (typeof expiresAt === 'number') {
        expires = new Date();
        expires.setDate(expires.getDate() + expiresAt);
    } else if (typeof expiresAt === 'string') expires = new Date(expiresAt);
    else expires = new Date(0);
    if (!Number.isFinite(expires.getTime())) throw new Error('Invalid Premium expiry');

    await db.query(`INSERT INTO users (id, email, dodo_customer_id, premium_expires, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, users.email),
          dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, users.dodo_customer_id),
          premium_expires = GREATEST(COALESCE(users.premium_expires, EXCLUDED.premium_expires), EXCLUDED.premium_expires),
          updated_at = NOW()`, [userId, email, dodoCustomerId, expires]);
    console.log(`✅ Premium for ${userId} until ${expires.toISOString()}`);
}

// A delayed expiry webhook must never revoke a later successful renewal.
// Payment ledger lives in the same database transaction as entitlement and event marker.
// Dodo payment IDs de-duplicate distinct webhook deliveries of the same successful charge.
// Missing charge IDs fail closed rather than using a different event ID as another payment.
// Amount is stored in Dodo's smallest currency unit (e.g., cents), not card data.
export async function recordSuccessfulPayment(userId, eventId, data, db = pool) {
    const paymentId = typeof data?.payment_id === 'string' && data.payment_id.trim()
        ? data.payment_id.trim() : null;
    // Dodo declares payment_id required for payment webhooks. Fail and retry
    // malformed events rather than treating a new event ID as a new charge.
    if (!paymentId || paymentId.length > 200) {
        throw new Error('Missing or invalid Dodo payment_id');
    }
    const recordId = 'dodo:' + paymentId;
    const rawAmount = data?.total_amount;
    const amount = typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) && rawAmount >= 0
        ? rawAmount : null;
    const currency = typeof data?.currency === 'string' && /^[a-z]{3}$/i.test(data.currency)
        ? data.currency.toUpperCase() : null;

    // FK-safe even for the first payment of a previously unknown user.
    await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
    const record = await db.query(
        `INSERT INTO payments (id, user_id, dodo_payment_id, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [recordId, userId, paymentId, amount, currency, 'succeeded']
    );
    return record.rows.length > 0;
}

/**
 * Record refund/dispute evidence atomically with the authenticated webhook
 * transport marker. Never revoke Premium or trust userId from reversal
 * metadata. A historical payment may not yet exist in the new ledger; keep
 * an unmatched audit row instead of guessing an account or dropping evidence.
 */
export async function recordPaymentRiskEvent({eventId,eventType,data},db=pool) {
    const validId=value => typeof value==='string' &&
        /^[A-Za-z0-9_-]{5,200}$/.test(value);
    const sourceId=eventType.startsWith('refund.')
        ? data?.refund_id : data?.dispute_id;
    if(!validId(eventId) || !validId(sourceId) ||
       !validId(data?.payment_id) ||
       !/^pay_[A-Za-z0-9_-]{5,190}$/.test(data.payment_id)) {
        throw Error('Dodo reversal evidence missing verified payment reference');
    }
    const customerId=data?.customer?.customer_id;
    if(customerId!=null && (!validId(customerId) ||
       !/^cus_[A-Za-z0-9_-]{5,190}$/.test(customerId))) {
        throw Error('Dodo reversal evidence has invalid customer reference');
    }
    const row=await db.query(
        `INSERT INTO payment_risk_events
            (webhook_id,event_type,provider_record_id,dodo_payment_id,dodo_customer_id,matched_payment_user_id)
         SELECT $1,$2,$3,$4,$5,
                (SELECT p.user_id FROM payments p WHERE p.dodo_payment_id=$4)
         RETURNING matched_payment_user_id`,
        [eventId,eventType,sourceId,data.payment_id,customerId??null]
    );
    if(row.rowCount!==1)throw Error('Dodo reversal event not recorded');
    return {
        action:'payment_risk_review_pending',
        paymentMatched:row.rows[0].matched_payment_user_id!=null
    };
}

export async function expirePremiumIfElapsed(userId, now = new Date(), db = pool) {
    await db.query(`UPDATE users SET premium_expires = $2, updated_at = NOW()
        WHERE id = $1 AND premium_expires <= $3`, [userId, new Date(0), now]);
}

export async function getUserByDodoCustomer(customerId, db = pool) {
    const result = await db.query('SELECT id FROM users WHERE dodo_customer_id = $1', [customerId]);
    return result.rows[0] || null;
}

export async function withWebhookTransaction(eventId, eventType, callback) {
    return runWebhookTransaction(pool, eventId, eventType, callback);
}

export default pool;
