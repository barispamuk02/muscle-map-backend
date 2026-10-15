import pg from 'pg';
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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_dodo_customer ON users(dodo_customer_id)');
    console.log('✅ DB initialized');
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
