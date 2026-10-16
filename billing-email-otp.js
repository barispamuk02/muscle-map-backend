import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import pool from './db.js';

function valid(value,prefix) {
    return typeof value==='string' &&
        new RegExp('^'+prefix+'_[A-Za-z0-9_-]{8,180}$').test(value);
}
function normEmail(e) {
    return typeof e==='string' && e.length<=254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : null;
}
function digest(secret,id,code) {
    return createHmac('sha256',secret).update(id+':'+code).digest('hex');
}
function validateConfig({issuer,subject,customerId,secret}) {
    if(typeof issuer!=='string'||!issuer.startsWith('https://')||
        typeof subject!=='string'||subject.length<3||subject.length>255||
        !valid(customerId,'cus')||typeof secret!=='string'||secret.length<32) {
        throw Error('Billing challenge requires verified identity and a server-held secret');
    }
}
/**
 * INTERNAL OPERATOR WORKFLOW ONLY. Not mounted as an unauthenticated route.
 *
 * Recipient must come directly from Dodo LIVE merchant read and MUST be
 * equal to independently verified Neon identity email. sendEmail is a
 * trusted transactional email provider callback; no provider is configured
 * yet and production cannot use this until delivery/abuse tests pass.
 */
export async function issueBillingEmailChallenge({
    issuer,subject,customerId,recipientEmail,merchantEmail,verifiedNeonEmail,
    secret,sendEmail,db=pool,now=new Date()
}) {
    validateConfig({issuer,subject,customerId,secret});
    const recipient=normEmail(recipientEmail);
    if(!recipient||recipient!==normEmail(merchantEmail)||
        recipient!==normEmail(verifiedNeonEmail)||typeof sendEmail!=='function')
        throw Error('Recipient must equal independent verified merchant and login email');
    if (!(now instanceof Date)||!Number.isFinite(now.getTime())) throw Error('Invalid clock');
    const id='clm_'+randomBytes(20).toString('hex');
    const otp=String(randomInt(0,1000000)).padStart(6,'0');
    const hash=digest(secret,id,otp);
    const dbh=await db.connect();
    let begun=false;
    try{
        await dbh.query('BEGIN');begun=true;
        // serialize concurrent issue attempts for this auth identity and customer
        await dbh.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[issuer,subject]);
        await dbh.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['billing-customer',customerId]);
        const rate=await dbh.query(
            'SELECT COUNT(*)::int AS n FROM billing_email_challenges WHERE ((issuer=$1 AND subject=$2) OR customer_id=$3) AND created_at > $4',
            [issuer,subject,customerId,new Date(now.getTime()-3600000)]
        );
        if(rate.rows[0].n>=3)throw Error('Billing challenge hourly rate limit reached');
        const until=new Date(now.getTime()+10*60*1000);
        await dbh.query(
            'INSERT INTO billing_email_challenges (id,issuer,subject,customer_id,recipient_email,code_digest,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [id,issuer,subject,customerId,recipient,hash,now,until]
        );
        // Never return plaintext OTP from this function.
        await sendEmail({to:recipient,code:otp,expiresAt:until});
        await dbh.query('UPDATE billing_email_challenges SET sent_at=$2 WHERE id=$1',[id,now]);
        await dbh.query('COMMIT');begun=false;
        return {challengeId:id,expiresAt:until.toISOString()};
    }catch(err){
        if(begun)await dbh.query('ROLLBACK');
        throw err;
    }finally{dbh.release();}
}

/** Confirm once, in a single locked transaction, maximum five attempts. */
export async function confirmBillingEmailChallenge({
    challengeId,issuer,subject,code,secret,db=pool,now=new Date()
}) {
    if(!valid(challengeId,'clm')||typeof issuer!=='string'||
        typeof subject!=='string'||typeof secret!=='string'||secret.length<32||
        typeof code!=='string'||!/^\d{6}$/.test(code))
        throw Error('Invalid billing verification request');
    const client=await db.connect();
    let begun=false;
    try{
        await client.query('BEGIN');begun=true;
        const r=await client.query(
            'SELECT issuer,subject,customer_id,recipient_email,code_digest,expires_at,sent_at,consumed_at,attempts FROM billing_email_challenges WHERE id=$1 FOR UPDATE',[challengeId]
        );
        const row=r.rows[0];
        if(!row||row.issuer!==issuer||row.subject!==subject||
            !row.sent_at||row.consumed_at||row.attempts>=5||
            new Date(row.expires_at)<=now) throw Error('Challenge unavailable or expired');
        const expected=Buffer.from(row.code_digest,'hex');
        const actual=Buffer.from(digest(secret,challengeId,code),'hex');
        const ok=expected.length===actual.length && timingSafeEqual(expected,actual);
        if(!ok){
            await client.query('UPDATE billing_email_challenges SET attempts=attempts+1 WHERE id=$1',[challengeId]);
            await client.query('COMMIT');begun=false;
            throw Error('Invalid or expired billing verification code');
        }
        await client.query('UPDATE billing_email_challenges SET consumed_at=$2, attempts=attempts+1 WHERE id=$1',
            [challengeId,now]);
        await client.query('COMMIT');begun=false;
        return {
            challengeId,method:'billing_email_otp',status:'consumed_once',
            issuer,subject,customerId:row.customer_id,
            recipientEmail:row.recipient_email,verifiedAt:now.toISOString()
        };
    }catch(err){
        if(begun)await client.query('ROLLBACK');
        throw err;
    }finally{client.release();}
}


/**
 * Trusted server-side evidence loader. Never accept a challenge object directly
 * from the browser when authorizing an account migration.
 */
export async function readConsumedBillingChallenge({
    challengeId,issuer,subject,db=pool,now=new Date()
}) {
    if(!valid(challengeId,'clm')||typeof issuer!=='string'||typeof subject!=='string')
        throw Error('Invalid private challenge lookup');
    const r=await db.query(
        'SELECT issuer,subject,customer_id,recipient_email,sent_at,consumed_at,expires_at,attempts FROM billing_email_challenges WHERE id=$1',
        [challengeId]
    );
    const x=r.rows[0];
    const confirmed=new Date(x?.consumed_at);
    if(!x||x.issuer!==issuer||x.subject!==subject||!x.sent_at||
        !x.consumed_at||!Number.isFinite(confirmed.getTime())||
        confirmed>now||confirmed.getTime()>new Date(x.expires_at).getTime()||
        now.getTime()-confirmed.getTime()>10*60000||x.attempts>5)
        throw Error('No recent consumed billing email challenge');
    return {
        challengeId,method:'billing_email_otp',status:'consumed_once',
        issuer,subject,customerId:x.customer_id,
        recipientEmail:x.recipient_email,verifiedAt:confirmed.toISOString()
    };
}
