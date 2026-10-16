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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_dodo_customer ON users(dodo_customer_id)');
    // A second durable constraint independent of the deterministic payment record ID.
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_dodo_id ON payments(dodo_payment_id) WHERE dodo_payment_id IS NOT NULL');
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
