/**
 * Privileged staging-account linkage preparation.
 *
 * Preview is read-only (Dodo GET + Neon SELECT) and available to the
 * isolated local operator only. The APPLY function is fail-closed until
 * a separate, explicitly reviewed Ed25519 admin public-key enrollment.
 * Neither function is mounted as an HTTP route or enabled in Render.
 */
import pool from './db.js';
import {retrieveDodoLiveBilling} from './dodo-ownership-audit.js';
import {preflightStagingBillingOwnership} from './staging-billing-preflight.js';
import {makeTrustedDodoClaimReviewer} from './trusted-dodo-claim-review.js';
import {linkLegacyPremiumAfterReview} from './legacy-account-claim.js';
import {assertIsolatedStagingClaimEnvironment,
    verifyIndependentStagingApproval,STAGING_CLAIM_ISSUER} from './staging-claim-approval.js';

// Owner-provided PUBLIC SHA-256 fingerprint of a Windows-local encrypted
// Ed25519 operator key. No private key, passphrase or authentication secret is
// stored in source. This enrollment alone does not initiate any claim.
export const ENROLLED_OPERATOR_ED25519_FINGERPRINT =
    '68dc0b78c07acaa3e3e867744fcfa7f06182852140be02a52fa18dab6a079cac';

function validId(value,prefix) {
    return typeof value==='string' &&
        new RegExp('^'+prefix+'_[A-Za-z0-9_-]{8,180}$').test(value);
}

async function collectPreview({env,db,http,now}) {
    assertIsolatedStagingClaimEnvironment(env);
    if(!validId(env.STAGING_PAYMENT_ID,'pay') ||
       !validId(env.STAGING_SUBSCRIPTION_ID,'sub') ||
       typeof env.DODO_AUDIT_API_KEY!=='string' ||
       env.DODO_AUDIT_API_KEY.length<20) {
        throw Error('STAGING_MERCHANT_READ_ONLY_CONFIGURATION_REQUIRED');
    }
    const {payment,subscription}=await retrieveDodoLiveBilling({
        paymentId:env.STAGING_PAYMENT_ID,
        subscriptionId:env.STAGING_SUBSCRIPTION_ID,
        apiKey:env.DODO_AUDIT_API_KEY,http
    });
    const matched=await preflightStagingBillingOwnership({
        payment,subscription,db,expectedIssuer:STAGING_CLAIM_ISSUER,now
    });
    const old=await db.query(
        'SELECT premium_expires FROM users WHERE id=$1 AND dodo_customer_id=$2',
        [matched.legacyUserId,matched.customerId]
    );
    if(old.rowCount!==1)throw Error('STAGING_LEGACY_SUBSCRIBER_MISSING');
    const actualExpiry=new Date(old.rows[0].premium_expires).getTime();
    const merchantExpiry=new Date(matched.paidThrough).getTime();
    const expiryMatches=Number.isFinite(actualExpiry) &&
        Number.isFinite(merchantExpiry) && actualExpiry===merchantExpiry;
    const correctionEligible=Number.isFinite(actualExpiry) &&
        Number.isFinite(merchantExpiry) && actualExpiry>now.getTime() &&
        actualExpiry<merchantExpiry;
    return {matched,payment,subscription,expiryMatches,correctionEligible};
}

export async function previewStagingPremiumClaim({
    env=process.env,db=pool,http=fetch,now=new Date()
}={}) {
    const p=await collectPreview({env,db,http,now});
    return Object.freeze({
        merchantVerified:true,verifiedNeonAccount:true,
        eligibleLegacyPaidCustomer:true,
        historicalExpiryMatchesDodo:p.expiryMatches,
        correctionInSameApprovedClaim:p.correctionEligible,
        freshOtpRequired:true,
        independentAdminApprovalRequired:true,
        actualLinkPerformed:false
    });
}

/**
 * This function is deliberately dormant until enrollment.
 * Approval is cryptographically bound to the exact Dodo payment, subscription,
 * one consumed fresh OTP and verified Neon subject. All issuer/customer
 * records are independently re-read. Caller cannot supply a Premium userId.
 */
export async function applyApprovedStagingPremiumClaim({
    env=process.env,approval,operatorPublicKeyPem,
    db=pool,http=fetch,now=()=>new Date()
}={}) {
    assertIsolatedStagingClaimEnvironment(env);
    if(env.STAGING_OPERATOR_ACTION!=='APPROVE_STAGING_CLAIM' ||
       !ENROLLED_OPERATOR_ED25519_FINGERPRINT) {
        throw Error('STAGING_CLAIM_APPLY_DISABLED_PENDING_OWNER_ENROLLMENT');
    }
    const context=await collectPreview({env,db,http,now:now()});
    // A legacy period shorter than Dodo's authenticated paid-through is
    // corrected atomically by linkLegacyPremiumAfterReview after fresh OTP.
    // The migration primitive itself rejects any attempt to shorten a term.
    if(!context.expiryMatches && !context.correctionEligible)
        throw Error('STAGING_CLAIM_MERCHANT_ENTITLEMENT_CONFLICT');
    const m=context.matched;
    const approvalProof=verifyIndependentStagingApproval({
        approval,publicKeyPem:operatorPublicKeyPem,
        trustedFingerprint:ENROLLED_OPERATOR_ED25519_FINGERPRINT,
        expected:{
            issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId,
            customerId:m.customerId,paymentId:env.STAGING_PAYMENT_ID,
            subscriptionId:env.STAGING_SUBSCRIPTION_ID,
            productId:context.subscription.product_id
        },now:now()
    });
    const reviewer=makeTrustedDodoClaimReviewer({
        expectedIssuer:m.issuer,paymentId:env.STAGING_PAYMENT_ID,
        subscriptionId:env.STAGING_SUBSCRIPTION_ID,
        productId:context.subscription.product_id,
        challengeId:approvalProof.challengeId,
        apiKey:env.DODO_AUDIT_API_KEY,db,http,now
    });
    // Verify the fresh consumed OTP and merchant record AGAIN immediately
    // before requesting the guarded, atomic migration primitive.
    const verified=await reviewer({
        issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId
    });
    if(verified.verified!==true ||
       verified.evidenceReference!=='dodo-audit:'+approvalProof.challengeId ||
       verified.paidThrough!==m.paidThrough)
        throw Error('STAGING_CLAIM_FRESH_INDEPENDENT_EVIDENCE_MISMATCH');
    return linkLegacyPremiumAfterReview({
        issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId,
        reviewedBy:approvalProof.reviewedBy,
        proofMethod:'dodo_merchant_manually_verified',
        evidenceReference:verified.evidenceReference,
        operatorApprovalReference:approvalProof.approvalReference
    },reviewer,db);
}
