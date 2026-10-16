/**
 * Local operator ONLY: Dodo LIVE GET -> staging Neon verification ->
 * independent billing mailbox OTP via Resend, with explicit SEND consent.
 * No checkout/refund, no subscription transfer and no production DB.
 * This script must not run in Render, GitHub Actions or a browser.
 */
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import pool from '../db.js';
import {retrieveDodoLiveBilling} from '../dodo-ownership-audit.js';
import {preflightStagingBillingOwnership} from '../staging-billing-preflight.js';
import {issueBillingEmailChallenge} from '../billing-email-otp.js';
import {sendBillingClaimCode} from '../resend-mailer.js';

const fail=msg=>{console.error(msg);process.exitCode=1};
const STAGING_HOSTS=new Set([
    'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
    'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
]);
function configIsSafe(){
    let address;
    try{address=new URL(process.env.DATABASE_URL)}catch{return false}
    return (address.protocol==='postgresql:' || address.protocol==='postgres:') &&
        STAGING_HOSTS.has(address.hostname.toLowerCase()) &&
        process.env.APP_ENV==='staging' &&
        process.env.DODO_AUDIT_API_KEY?.length>=20 &&
        /^re_[A-Za-z0-9_-]{10,}$/.test(process.env.RESEND_API_KEY||'') &&
        process.env.OTP_HMAC_SECRET?.length>=32 &&
        process.env.AUTH_ISSUER==='https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
}
if(!configIsSafe()) {
    fail('STAGING_OTP_ENVIRONMENT_GUARD_FAILED: local operator must use staging-only DB and verified credentials.');
}else{
    const rl=createInterface({input,output,terminal:Boolean(input.isTTY)});
    try{
        console.log('LOCAL STAGING OTP: Dodo LIVE GET-only. No billing or production changes.');
        // The PowerShell launcher supplies both IDs with hidden prompts.
        // Manual fallback is retained only for controlled operator diagnosis.
        const paymentId=(process.env.STAGING_PAYMENT_ID ||
            await rl.question('Dodo LIVE payment ID (pay_...): ')).trim();
        const subscriptionId=(process.env.STAGING_SUBSCRIPTION_ID ||
            await rl.question('Dodo LIVE subscription ID (sub_...): ')).trim();
        const {payment,subscription}=await retrieveDodoLiveBilling({
            paymentId,subscriptionId,apiKey:process.env.DODO_AUDIT_API_KEY
        });
        const match=await preflightStagingBillingOwnership({
            payment,subscription,db:pool,expectedIssuer:process.env.AUTH_ISSUER
        });
        console.log('STAGING_VERIFIED_LOGIN_AND_DODO_CUSTOMER_MATCH=YES');
        console.log('MERCHANT_PAID_THROUGH_UTC='+match.paidThrough);
        console.log('No account will be linked or changed by this OTP step.');
        const confirmation=(await rl.question('Send one independent OTP to Dodo billing address? Type SEND: ')).trim();
        if(confirmation!=='SEND') {
            console.log('CANCELLED_NO_EMAIL_SENT');
        } else{
            const sent=await issueBillingEmailChallenge({
                issuer:match.issuer,subject:match.subject,
                customerId:match.customerId,recipientEmail:match.billingEmail,
                merchantEmail:match.billingEmail,verifiedNeonEmail:match.verifiedNeonEmail,
                secret:process.env.OTP_HMAC_SECRET,
                db:pool,sendEmail:sendBillingClaimCode
            });
            console.log('STAGING_BILLING_OTP_EMAIL_ACCEPTED=YES');
            console.log('LOCAL_CHALLENGE_ID='+sent.challengeId);
            console.log('EXPIRES_AT_UTC='+sent.expiresAt);
            console.log('Use this challenge ID ONLY locally for verification. Do NOT share the code or ID in chat.');
        }
    }catch(error){
        // Do not print full provider, database, or delivery errors: such errors
        // may contain sensitive URLs or identifying information.
        fail('STAGING_OTP_NEEDS_REVIEW: '+(/^(MANUAL_REVIEW_|CLAIM_PREFLIGHT_)/.test(error?.message||'')?
            error.message:'CHECK_LOCAL_KEY_DB_CONNECTION_AND_MERCHANT_RECORD'));
    }finally{
        rl.close();
        await pool.end();
    }
}
