/**
 * Real PostgreSQL schema-only rehearsal against disposable CI database.
 * NEVER accepts Neon host or production/staging branch.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import {PRODUCTION_AUTH_SCHEMA_SQL,
    applyProductionAuthSchema} from '../production-auth-schema-migration.js';

const url=process.env.DATABASE_URL;
const parsed=(()=>{try{return new URL(url)}catch{return null}})();
if(!parsed || !['localhost','127.0.0.1'].includes(parsed.hostname) ||
   parsed.pathname!=='/muscle_map_ci' || !url.includes('sslmode=disable')) {
    throw Error('PRODUCTION_SCHEMA_INTEGRATION_REQUIRES_DISPOSABLE_LOCAL_CI_ONLY');
}
const pool=new pg.Pool({connectionString:url,ssl:false,max:3});
const legacyId='u_ci_prod_migration_baseline_123456';
const extraId='u_ci_prod_migration_other_123456';
const newerId='u_ci_prod_migration_no_customer_123456';
const expiry=new Date('2026-11-14T04:23:24.489Z');
async function snapshot() {
    const x=await pool.query(`SELECT id,email,dodo_customer_id,premium_expires
        FROM public.users WHERE id=ANY($1::text[]) ORDER BY id`,
        [[legacyId,extraId,newerId]]);
    const payments=await pool.query('SELECT COUNT(*)::int AS n FROM public.payments');
    const webhooks=await pool.query('SELECT COUNT(*)::int AS n FROM public.webhook_events');
    return JSON.stringify({
        users:x.rows,payments:payments.rows[0].n,webhooks:webhooks.rows[0].n
    });
}
try{
    await pool.query(`CREATE TABLE IF NOT EXISTS public.users(
        id TEXT PRIMARY KEY,email TEXT,dodo_customer_id TEXT,
        premium_expires TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.payments(
        id TEXT PRIMARY KEY,user_id TEXT REFERENCES public.users(id),
        dodo_payment_id TEXT,amount NUMERIC,currency TEXT,status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.webhook_events(
        id TEXT PRIMARY KEY,event_type TEXT,processed_at TIMESTAMPTZ DEFAULT NOW())`);
    for(const [id,dodo] of [
        [legacyId,'cus_ci_prod_schema_owner_123456'],
        [extraId,'cus_ci_prod_schema_other_123456'],[newerId,null]
    ])await pool.query(`INSERT INTO public.users(id,email,dodo_customer_id,premium_expires)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
        [id,null,dodo,expiry]);
    await pool.query(`INSERT INTO public.webhook_events(id,event_type)
        VALUES('evt_ci_prod_schema_first','payment.succeeded'),
              ('evt_ci_prod_schema_second','payment.succeeded')
        ON CONFLICT(id) DO NOTHING`);
    const original=await snapshot();
    const c=await pool.connect();let begun=false;
    try{
        await c.query('BEGIN');begun=true;
        for(const sql of PRODUCTION_AUTH_SCHEMA_SQL)await c.query(sql);
        await c.query('COMMIT');begun=false;
    }catch(e){if(begun)await c.query('ROLLBACK');throw e}
    finally{c.release()}

    assert.equal(await snapshot(),original,
        'No user, Premium expiry, payments or webhooks may change');
    const expected=[
        'auth_identities','legacy_account_claims',
        'legacy_account_claim_reversals',
        'payment_risk_events','billing_email_challenges'
    ];
    const tables=await pool.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])`,
        [expected]);
    assert.deepEqual(tables.rows.map(r=>r.table_name).sort(),expected.slice().sort());

    // Re-applying additive DDL must be idempotent.
    for(const sql of PRODUCTION_AUTH_SCHEMA_SQL)await pool.query(sql);
    assert.equal(await snapshot(),original);
    const index=await pool.query(`SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])`,
        [['idx_users_unique_dodo_customer','idx_payments_unique_dodo_id','idx_legacy_claim_approval']]);
    assert.equal(index.rowCount,3);

    // Even a CI caller with the 'approval' strings must not address localhost.
    await assert.rejects(()=>applyProductionAuthSchema(pool,{
        APP_ENV:'production',
        AUTH_ISSUER:'https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech',
        DATABASE_URL:url,
        PRODUCTION_SCHEMA_ACTION:'APPLY_APPROVED_PRODUCTION_AUTH_SCHEMA',
        PRODUCTION_OWNER_APPROVAL:'APPROVED_ONE_TIME_BUSINESS_SCHEMA'
    }),/PRODUCTION_DATABASE_TARGET_REJECTED/);
    console.log('PRODUCTION_AUTH_SCHEMA_DISPOSABLE_POSTGRES_REHEARSAL=PASS');
    console.log('LEGACY_USERS_PREMIUM_PAYMENTS_WEBHOOKS=UNCHANGED');
}finally{await pool.end()}
