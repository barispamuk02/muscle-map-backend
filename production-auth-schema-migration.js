/**
 * Opt-in Production business-schema migration; NEVER invoked by server startup.
 * Default entry is an inert, testable plan. This code performs no database
 * writes unless a separate operator program explicitly calls apply() with
 * the exact Production schema approval after a preflight.
 */
export const PRODUCTION_AUTH_ISSUER =
    'https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech';
export const PRODUCTION_DB_HOST =
    'ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech';
const STAGING_HOST_FRAGMENT='ep-summer-recipe-b1qi9f29';
const HOSTS=new Set([PRODUCTION_DB_HOST,
    'ep-muddy-rice-b1y5qbz8-pooler.c-5.eu-central-1.aws.neon.tech']);

export function assertProductionDatabaseTarget(env={}) {
    let u;
    try { u=new URL(env.DATABASE_URL); } catch { throw Error('PRODUCTION_DATABASE_TARGET_REJECTED'); }
    if (env.APP_ENV!=='production' || env.AUTH_ISSUER!==PRODUCTION_AUTH_ISSUER ||
        !['postgres:','postgresql:'].includes(u.protocol) ||
        !HOSTS.has(u.hostname.toLowerCase()) ||
        u.hostname.includes(STAGING_HOST_FRAGMENT) ||
        u.searchParams.get('sslmode')!=='verify-full' ||
        env.DB_ALLOW_SELF_SIGNED==='true' ||
        env.STAGING_DB_HOSTS || env.STAGING_OPERATOR_ACTION ||
        env.STAGING_LOCAL_OWNER_CONFIRM ||
        (env.PRODUCTION_DB_HOST && env.PRODUCTION_DB_HOST!==PRODUCTION_DB_HOST)) {
        throw Error('PRODUCTION_DATABASE_TARGET_REJECTED');
    }
    return Object.freeze({environment:'production',host:u.hostname});
}

// These DDL statements are additive and match initDb() in Draft PR #2.
// No legacy users, payments, webhook history, paid expiry or Neon Auth user
// rows are updated. The SQL is also used in disposable PostgreSQL CI.
export const PRODUCTION_AUTH_SCHEMA_SQL=Object.freeze([
`CREATE TABLE IF NOT EXISTS public.auth_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (issuer,subject))`,
`CREATE TABLE IF NOT EXISTS public.legacy_account_claims (
    legacy_user_id TEXT PRIMARY KEY REFERENCES public.users(id),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    dodo_customer_id TEXT NOT NULL,
    evidence_reference TEXT NOT NULL UNIQUE,
    proof_method TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    previous_user_id TEXT REFERENCES public.users(id),
    premium_expires_at_claim TIMESTAMPTZ,
    premium_expires_after_claim TIMESTAMPTZ,
    operator_approval_reference TEXT,
    UNIQUE (issuer,subject))`,
`ALTER TABLE public.legacy_account_claims ADD COLUMN IF NOT EXISTS previous_user_id TEXT REFERENCES public.users(id)`,
`ALTER TABLE public.legacy_account_claims ADD COLUMN IF NOT EXISTS premium_expires_at_claim TIMESTAMPTZ`,
`ALTER TABLE public.legacy_account_claims ADD COLUMN IF NOT EXISTS premium_expires_after_claim TIMESTAMPTZ`,
`ALTER TABLE public.legacy_account_claims ADD COLUMN IF NOT EXISTS operator_approval_reference TEXT`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_claim_approval
    ON public.legacy_account_claims(operator_approval_reference)
    WHERE operator_approval_reference IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS public.legacy_account_claim_reversals (
    legacy_user_id TEXT PRIMARY KEY REFERENCES public.legacy_account_claims(legacy_user_id),
    previous_user_id TEXT NOT NULL UNIQUE REFERENCES public.users(id),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    original_evidence_reference TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    reversed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS public.payment_risk_events (
    webhook_id TEXT PRIMARY KEY REFERENCES public.webhook_events(id),
    event_type TEXT NOT NULL,
    provider_record_id TEXT NOT NULL,
    dodo_payment_id TEXT NOT NULL,
    dodo_customer_id TEXT,
    matched_payment_user_id TEXT REFERENCES public.users(id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending','reviewed')))`,
`CREATE INDEX IF NOT EXISTS idx_payment_risk_lookup
    ON public.payment_risk_events(dodo_payment_id,received_at DESC)`,
`CREATE TABLE IF NOT EXISTS public.billing_email_challenges (
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
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts>=0 AND attempts<=5))`,
`CREATE INDEX IF NOT EXISTS idx_billing_challenge_identity
    ON public.billing_email_challenges(issuer,subject,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_users_dodo_customer
    ON public.users(dodo_customer_id)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_dodo_customer
    ON public.users(dodo_customer_id) WHERE dodo_customer_id IS NOT NULL`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_dodo_id
    ON public.payments(dodo_payment_id) WHERE dodo_payment_id IS NOT NULL`
]);

export async function inspectProductionAuthSchema(db,env) {
    assertProductionDatabaseTarget(env);
    if(!db?.query) throw Error('PRODUCTION_SCHEMA_DATABASE_REQUIRED');
    const [duplicateCustomers,duplicatePayments,tables]=await Promise.all([
        db.query(`SELECT COUNT(*)::int AS n FROM (
            SELECT dodo_customer_id FROM public.users WHERE dodo_customer_id IS NOT NULL
            GROUP BY dodo_customer_id HAVING COUNT(*)>1) x`),
        db.query(`SELECT COUNT(*)::int AS n FROM (
            SELECT dodo_payment_id FROM public.payments WHERE dodo_payment_id IS NOT NULL
            GROUP BY dodo_payment_id HAVING COUNT(*)>1) x`),
        db.query(`SELECT table_name FROM information_schema.tables
            WHERE table_schema='public'
              AND table_name IN ('auth_identities','legacy_account_claims',
                  'legacy_account_claim_reversals','payment_risk_events','billing_email_challenges')`)
    ]);
    if(+duplicateCustomers.rows[0].n!==0||+duplicatePayments.rows[0].n!==0)
        throw Error('PRODUCTION_SCHEMA_PRECHECK_DUPLICATE_MERCHANT_IDENTIFIERS');
    return Object.freeze({mode:'READ_ONLY',duplicates:0,
        presentTables:tables.rows.map(r=>r.table_name).sort(),
        statements:PRODUCTION_AUTH_SCHEMA_SQL.length});
}

export async function applyProductionAuthSchema(db,env) {
    assertProductionDatabaseTarget(env);
    if(env.PRODUCTION_SCHEMA_ACTION!=='APPLY_APPROVED_PRODUCTION_AUTH_SCHEMA' ||
       env.PRODUCTION_OWNER_APPROVAL!=='APPROVED_ONE_TIME_BUSINESS_SCHEMA' ||
       !db?.connect) throw Error('PRODUCTION_SCHEMA_EXPLICIT_APPROVAL_REQUIRED');
    // Precheck before beginning; duplicate uniqueness must be safe.
    await inspectProductionAuthSchema(db,env);
    const client=await db.connect();
    let begun=false;
    try {
        await client.query('BEGIN');begun=true;
        await client.query("SELECT pg_advisory_xact_lock(hashtext('muscle-map'),hashtext('production-auth-schema'))");
        // Recheck under transaction, including concurrent id collisions.
        const dup=await client.query(`SELECT
           (SELECT count(*) FROM (SELECT dodo_customer_id FROM public.users
            WHERE dodo_customer_id IS NOT NULL GROUP BY dodo_customer_id HAVING count(*)>1) a)
          +(SELECT count(*) FROM (SELECT dodo_payment_id FROM public.payments
            WHERE dodo_payment_id IS NOT NULL GROUP BY dodo_payment_id HAVING count(*)>1) b)
          AS duplicate_count`);
        if(+dup.rows[0].duplicate_count!==0)
            throw Error('PRODUCTION_SCHEMA_PRECHECK_DUPLICATE_MERCHANT_IDENTIFIERS');
        for(const sql of PRODUCTION_AUTH_SCHEMA_SQL) await client.query(sql);
        await client.query('COMMIT');begun=false;
        return Object.freeze({status:'SCHEMA_ONLY_APPLIED',statements:PRODUCTION_AUTH_SCHEMA_SQL.length});
    }catch(error) {
        if(begun)await client.query('ROLLBACK');
        throw error;
    }finally{client.release();}
}
