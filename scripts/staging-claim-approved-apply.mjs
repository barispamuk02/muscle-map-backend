/**
 * Execute ONE owner-approved, locally signed Premium claim on isolated Neon
 * STAGING after the same terminal session has issued and consumed a fresh
 * Dodo billing email challenge. No public route or production execution.
 *
 * The private signing key is read only from the operator's workstation.
 * Merchant endpoints are GET-only. The claim is one atomic DB transaction.
 * No customer-identifying fields or secrets are printed.
 */
import {randomBytes} from 'node:crypto';
import pool from '../db.js';
import {retrieveDodoLiveBilling} from '../dodo-ownership-audit.js';
import {preflightStagingBillingOwnership} from '../staging-billing-preflight.js';
import {readConsumedBillingChallenge} from '../billing-email-otp.js';
import {signLocalStagingClaim} from '../staging-operator-local-key.js';
import {
    assertIsolatedStagingClaimEnvironment,STAGING_CLAIM_ISSUER
} from '../staging-claim-approval.js';
import {
    applyApprovedStagingPremiumClaim,ENROLLED_OPERATOR_ED25519_FINGERPRINT
} from '../staging-claim-operator.js';

const env=process.env;
async function applyOnce(){
    assertIsolatedStagingClaimEnvironment(env);
    if(env.STAGING_OPERATOR_ACTION!=='APPROVE_STAGING_CLAIM' ||
       env.STAGING_LOCAL_OWNER_CONFIRM!=='TRANSFER_ONE_PAID_PREMIUM_TO_STAGING' ||
       !/^clm_[a-f0-9]{40}$/.test(env.STAGING_CHALLENGE_ID||'') ||
       !/^pay_[A-Za-z0-9_-]{8,180}$/.test(env.STAGING_PAYMENT_ID||'') ||
       !/^sub_[A-Za-z0-9_-]{8,180}$/.test(env.STAGING_SUBSCRIPTION_ID||'') ||
       !ENROLLED_OPERATOR_ED25519_FINGERPRINT ||
       env.STAGING_OPERATOR_PASSPHRASE?.length<16 ||
       env.DODO_AUDIT_API_KEY?.length<20) {
        throw Error('STAGING_APPLY_NOT_AUTHORIZED_OR_MISSING_PRIVATE_INPUT');
    }
    const now=new Date();
    const {payment,subscription}=await retrieveDodoLiveBilling({
        paymentId:env.STAGING_PAYMENT_ID,
        subscriptionId:env.STAGING_SUBSCRIPTION_ID,
        apiKey:env.DODO_AUDIT_API_KEY
    });
    const matched=await preflightStagingBillingOwnership({
        payment,subscription,db:pool,expectedIssuer:STAGING_CLAIM_ISSUER,now
    });
    const challenge=await readConsumedBillingChallenge({
        challengeId:env.STAGING_CHALLENGE_ID,
        issuer:matched.issuer,subject:matched.subject,db:pool,now
    });
    if(challenge.customerId!==matched.customerId ||
       challenge.recipientEmail.trim().toLowerCase()!==matched.billingEmail ||
       challenge.recipientEmail.trim().toLowerCase()!==matched.verifiedNeonEmail) {
        throw Error('STAGING_APPLY_CUSTOMER_CHALLENGE_MISMATCH');
    }
    const payload={
        action:'STAGING_CLAIM_EXISTING_PREMIUM',
        issuer:matched.issuer,
        subject:matched.subject,
        legacyUserId:matched.legacyUserId,
        customerId:matched.customerId,
        paymentId:env.STAGING_PAYMENT_ID,
        subscriptionId:env.STAGING_SUBSCRIPTION_ID,
        productId:subscription.product_id,
        challengeId:env.STAGING_CHALLENGE_ID,
        reviewedBy:'owner-local-staging-operator',
        issuedAt:now.toISOString(),
        expiresAt:new Date(now.getTime()+3*60000).toISOString(),
        nonce:randomBytes(16).toString('hex')
    };
    const signed=await signLocalStagingClaim({
        passphrase:env.STAGING_OPERATOR_PASSPHRASE,payload
    });
    if(signed.publicKeyFingerprint!==ENROLLED_OPERATOR_ED25519_FINGERPRINT)
        throw Error('STAGING_APPLY_LOCAL_SIGNER_NOT_ENROLLED');
    const result=await applyApprovedStagingPremiumClaim({
        env,approval:signed.approval,
        operatorPublicKeyPem:signed.publicKeyPem,db:pool
    });
    if(result.alreadyLinked || result.userId!==matched.legacyUserId)
        throw Error('STAGING_APPLY_UNEXPECTED_LINK_RESULT');

    // Read-back is not authorization: it is a final, independent confirmation
    // that atomic claim, period extension, billing customer and login agree.
    const checked=await pool.query(
        'SELECT ai.user_id, u.dodo_customer_id,u.premium_expires, '+
        'lc.previous_user_id,lc.operator_approval_reference,'+
        'lc.premium_expires_after_claim '+
        'FROM auth_identities ai JOIN users u ON u.id=ai.user_id '+
        'JOIN legacy_account_claims lc ON lc.legacy_user_id=ai.user_id '+
        'WHERE ai.issuer=$1 AND ai.subject=$2',
        [matched.issuer,matched.subject]
    );
    const row=checked.rows[0];
    const paidThrough=new Date(matched.paidThrough).getTime();
    if(checked.rowCount!==1 ||
       row.user_id!==matched.legacyUserId ||
       row.dodo_customer_id!==matched.customerId ||
       row.previous_user_id===matched.legacyUserId ||
       typeof row.operator_approval_reference!=='string' ||
       !row.operator_approval_reference.startsWith('ed25519:') ||
       new Date(row.premium_expires).getTime()!==paidThrough ||
       new Date(row.premium_expires_after_claim).getTime()!==paidThrough) {
        throw Error('STAGING_APPLY_COMMITTED_BUT_READBACK_NEEDS_REVIEW');
    }
    console.log('STAGING_PREMIUM_CLAIM=COMPLETED');
    console.log('SIGNED_LOCAL_OPERATOR_APPROVAL=VERIFIED');
    console.log('NEON_STAGING_LOGIN_BOUND_TO_LEGACY_PAID_ACCOUNT=YES');
    console.log('PAID_THROUGH_RECONCILED_TO_MERCHANT=YES');
    console.log('DODO_LIVE_BILLING=READ_ONLY');
    console.log('PRODUCTION=UNTOUCHED');
}
try{
    await applyOnce();
}catch(error){
    // Never print raw provider/SQL/crypto exceptions with potentially
    // sensitive IDs or connection strings. One fixed category only.
    const safe=new Set([
        'STAGING_APPLY_NOT_AUTHORIZED_OR_MISSING_PRIVATE_INPUT',
        'STAGING_APPLY_CUSTOMER_CHALLENGE_MISMATCH',
        'STAGING_APPLY_LOCAL_SIGNER_NOT_ENROLLED',
        'STAGING_APPLY_UNEXPECTED_LINK_RESULT',
        'STAGING_APPLY_COMMITTED_BUT_READBACK_NEEDS_REVIEW'
    ]);
    console.error('STAGING_PREMIUM_CLAIM=NEEDS_REVIEW');
    console.error('SAFE_REASON='+(safe.has(error?.message)?error.message:'PRECHECK_OR_AUTH_OR_TRANSACTION_REJECTED'));
    process.exitCode=1;
}finally{
    await pool.end();
}
