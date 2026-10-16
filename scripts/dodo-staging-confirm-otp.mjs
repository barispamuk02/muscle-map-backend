/**
 * Local-only stage mailbox code confirmation. Requires the same operator
 * OTP_HMAC_SECRET and staging DATABASE_URL used for challenge issuance.
 * Does NOT grant or link Premium, nor contact Dodo or Resend.
 */
import pool from '../db.js';
import {confirmBillingEmailChallenge} from '../billing-email-otp.js';

const allowed=new Set([
    'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
    'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
]);
let url;
try{url=new URL(process.env.DATABASE_URL)}catch{}
const issuer='https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
const challengeId=process.env.STAGING_CHALLENGE_ID;
const code=process.env.STAGING_OTP_CODE;
if(!url || !allowed.has(url.hostname) ||
   !['postgresql:','postgres:'].includes(url.protocol) ||
   process.env.APP_ENV!=='staging' ||
   process.env.AUTH_ISSUER!==issuer ||
   typeof process.env.OTP_HMAC_SECRET!=='string' ||
   process.env.OTP_HMAC_SECRET.length<32 ||
   !/^clm_[a-f0-9]{40}$/.test(challengeId||'') ||
   !/^\d{6}$/.test(code||'')){
    console.error('LOCAL_STAGING_OTP_CONFIG_INVALID');
    process.exitCode=1;
}else{
    try{
        const r=await pool.query(
            'SELECT c.issuer,c.subject FROM billing_email_challenges c '+
            'JOIN auth_identities a ON a.issuer=c.issuer AND a.subject=c.subject '+
            'JOIN neon_auth."user" nu ON nu.id::text=c.subject '+
            'WHERE c.id=$1 AND c.issuer=$2 '+
            'AND nu."emailVerified" IS TRUE AND COALESCE(nu.banned,false) IS FALSE',
            [challengeId,issuer]
        );
        if(r.rowCount!==1)throw Error('verified identity unavailable');
        await confirmBillingEmailChallenge({
            challengeId,issuer,subject:r.rows[0].subject,
            code,secret:process.env.OTP_HMAC_SECRET,db:pool
        });
        console.log('INDEPENDENT_DODO_BILLING_EMAIL_OTP=VERIFIED_STAGING');
        console.log('PREMIUM_TRANSFER=NOT_PERFORMED');
        console.log('Keep the challenge ID PRIVATE on your computer for future admin review.');
    }catch{
        // Never reflect OTP or raw customer data into terminal errors.
        console.error('OTP_INVALID_EXPIRED_OR_UNAVAILABLE');
        process.exitCode=1;
    }finally{await pool.end()}
}
