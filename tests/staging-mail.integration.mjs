import assert from 'node:assert/strict';
import pg from 'pg';
import { initDb } from '../db.js';
import { sendStagingVerifiedMail } from '../staging-mail-test.js';

if (!process.env.DATABASE_URL?.includes('muscle_map_ci'))throw Error('Disposable DB only');
process.env.APP_ENV='staging';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false});
try {
    await initDb();
    await pool.query('CREATE SCHEMA IF NOT EXISTS neon_auth');
    await pool.query('CREATE TABLE IF NOT EXISTS neon_auth."user" (id uuid PRIMARY KEY,email text NOT NULL,"emailVerified" boolean NOT NULL,banned boolean NOT NULL DEFAULT false)');
    const issuer='https://staging.example.test';
    const verified='77777777-2222-4333-8444-555555555555';
    const unverified='88888888-2222-4333-8444-555555555555';
    await pool.query('INSERT INTO neon_auth."user"(id,email,"emailVerified",banned) VALUES ($1,$2,true,false),($3,$4,false,false) ON CONFLICT (id) DO NOTHING',
        [verified,'verified@example.test',unverified,'unverified@example.test']);
    let count=0,last=null;
    const sender=async mail=>{
        assert.equal(mail.to,'verified@example.test');
        assert.match(mail.idempotencyKey,/^mm-staging-mail\//);
        last=mail;count++;
        return {accepted:true};
    };
    const now=new Date('2026-10-16T05:00:00Z');
    const first=await sendStagingVerifiedMail({issuer,subject:verified,db:pool,now,sendMessage:sender});
    assert.deepEqual(first,{ok:true});
    assert.equal(count,1);
    assert.ok(last.subject.includes('staging'));
    await assert.rejects(sendStagingVerifiedMail({
        issuer,subject:verified,db:pool,now:new Date(now.getTime()+1000),
        sendMessage:sender
    }),/MAIL_TEST_RATE_LIMIT/);
    assert.equal(count,1);
    await assert.rejects(sendStagingVerifiedMail({
        issuer,subject:unverified,db:pool,now,sendMessage:sender
    }),/MAIL_IDENTITY_NOT_VERIFIED/);
    assert.equal(count,1);
    const expired=new Date(now.getTime()+25*60*60*1000);
    let failed=false;
    await assert.rejects(sendStagingVerifiedMail({
        issuer,subject:verified,db:pool,now:expired,
        sendMessage:async()=>{failed=true;throw Error('mail provider unavailable')}
    }),/mail provider unavailable/);
    assert.equal(failed,true);
    assert.equal((await pool.query(
        'SELECT requested_at FROM staging_mail_tests WHERE issuer=$1 AND subject=$2',
        [issuer,verified]
    )).rows[0].requested_at.toISOString(),now.toISOString(),'failed email must not consume quota');
    const second=await sendStagingVerifiedMail({issuer,subject:verified,db:pool,now:expired,sendMessage:sender});
    assert.equal(second.ok,true);
    assert.equal(count,2);
    console.log('STAGING_VERIFIED_NEON_ONLY_MAIL_THROTTLE_AND_FAILED_SEND_ROLLBACK_OK');
}finally{await pool.end();}
