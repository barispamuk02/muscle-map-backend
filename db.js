import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
});

// Инициализация таблиц
export async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT,
            dodo_customer_id TEXT,
            premium_expires TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id),
            dodo_payment_id TEXT,
            amount NUMERIC,
            currency TEXT,
            status TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_dodo_customer
        ON users(dodo_customer_id);
    `);

    console.log('✅ DB initialized');
}

// Проверка Premium
export async function isPremiumUser(userId) {
    const result = await pool.query(
        `SELECT premium_expires FROM users WHERE id = $1`,
        [userId]
    );
    if (result.rows.length === 0) return false;
    const expires = result.rows[0].premium_expires;
    if (!expires) return false;
    return new Date(expires) > new Date();
}

// Обновить Premium — принимает ДАТУ окончания (не дни!)
export async function setPremium(userId, expiresAt, email = null, dodoCustomerId = null) {
    let expires;
    
    if (expiresAt instanceof Date) {
        expires = expiresAt;
    } else if (typeof expiresAt === 'number') {
        // Обратная совместимость: если передали число — считаем как дни
        expires = new Date();
        expires.setDate(expires.getDate() + expiresAt);
    } else if (typeof expiresAt === 'string') {
        expires = new Date(expiresAt);
    } else {
        expires = new Date(0); // 1970 — Premium отключён
    }

    await pool.query(
        `INSERT INTO users (id, email, dodo_customer_id, premium_expires, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, users.email),
            dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, users.dodo_customer_id),
            premium_expires = EXCLUDED.premium_expires,
            updated_at = NOW()`,
        [userId, email, dodoCustomerId, expires]
    );

    console.log(`✅ Premium for ${userId} until ${expires.toISOString()}`);
}

// Получить пользователя по dodo_customer_id
export async function getUserByDodoCustomer(dodoCustomerId) {
    const result = await pool.query(
        `SELECT id FROM users WHERE dodo_customer_id = $1`,
        [dodoCustomerId]
    );
    return result.rows[0] || null;
}

export default pool;