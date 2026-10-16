/**
 * PRIVATE OFFLINE OPERATOR ONLY. Not imported into Express, not a public route.
 *
 * Read-only preview checks the same authenticated merchant + verified Neon
 * subscriber facts used on STAGING. Apply requires an independently enrolled
 * PRODUCTION Ed25519 signer, an independently consumed fresh billing OTP,
 * and a new explicit owner action. Its initial signer enrollment is EMPTY:
 * safe to ship Draft while production writes remain disabled.
 */
import {retrieveDodoLiveBilling} from './dodo-ownership-audit.js';
import {preflightStagingBillingOwnership} from './staging-billing-preflight.js';
import {readConsumedBillingChallenge} from './billing-email-otp.js';
import {makeTrustedDodoClaimReviewer} from './trusted-dodo-claim-review.js';
import {linkLegacyPremiumAfterReview} from './legacy-account-claim.js';
import {assertProductionDatabaseTarget,PRODUCTION_AUTH_ISSUER}
    from './production-auth-schema-migration.js';
import {verifyIndependentProductionClaimApproval,
    ENROLLED_PRODUCTION_APPROVER_FINGERPRINT}
    from './production-claim-approval.js';

function validId(value,prefix){
    return typeof value==='string' &&
        new RegExp('^'+prefix+'_[A-Za-z0-9_-]{8,180}$').test(value);
}
export function assertProductionClaimOperator(env) {
    assertProductionDatabaseTarget(env);
    if(env.DODO_API_KEY || env.DODO_WEBHOOK_SECRET ||
       env.STAGING_OPERATOR_ACTION || env.STAGING_LOCAL_OWNER_CONFIRM ||
       env.STAGING_PAYMENT_ID || env.STAGING_SUBSCRIPTION_ID ||
       env.NODE_ENV==='staging' ||
       !validId(env.PRODUCTION_PAYMENT_ID,'pay') ||
       !validId(env.PRODUCTION_SUBSCRIPTION_ID,'sub') ||
       typeof env.DODO_AUDIT_API_KEY!=='string' ||
       env.DODO_AUDIT_API_KEY.length<20)
        throw Error('PRODUCTION_CLAIM_OPERATOR_CONFIGURATION_REJECTED');
    return true;
}

async function collectPreview({env,db,http,now}) {
    assertProductionClaimOperator(env);
    if(!db?.query)throw Error('PRODUCTION_CLAIM_DATABASE_UNAVAILABLE');
    const {payment,subscription}=await retrieveDodoLiveBilling({
        paymentId:env.PRODUCTION_PAYMENT_ID,
        subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
        apiKey:env.DODO_AUDIT_API_KEY,http
    });
    // A trusted HTTP route is not sufficient: bind returned payload IDs
    // to the selected operator scope before reading any local customer row.
    if(payment?.payment_id!==env.PRODUCTION_PAYMENT_ID ||
       subscription?.subscription_id!==env.PRODUCTION_SUBSCRIPTION_ID)
        throw Error('PRODUCTION_CLAIM_MERCHANT_REFERENCE_MISMATCH');
    // Requires *both* an already initialized, verified Neon auth identity
    // (in public.auth_identities) and exactly one existing Dodo paid legacy user.
    // Never silently create placeholder rows or bind by email alone.
    const m=await preflightStagingBillingOwnership({
        payment,subscription,db,expectedIssuer:PRODUCTION_AUTH_ISSUER,now
    });
    const row=await db.query(
        'SELECT premium_expires FROM public.users WHERE id=$1 AND dodo_customer_id=$2',
        [m.legacyUserId,m.customerId]
    );
    if(row.rowCount!==1)throw Error('PRODUCTION_CLAIM_LEGACY_USER_NOT_FOUND');
    const previous=new Date(row.rows[0].premium_expires).getTime();
    const paidThrough=new Date(m.paidThrough).getTime();
    if(!Number.isFinite(previous)||!Number.isFinite(paidThrough)||
       previous>paidThrough || previous<=now.getTime())
        throw Error('PRODUCTION_CLAIM_PAID_PERIOD_CONFLICT');
    return {m,payment,subscription};
}

export async function previewProductionPaidClaim({
    env,db,http=fetch,now=new Date()
}={}) {
    const proof=await collectPreview({env,db,http,now});
    return Object.freeze({
        status:'PRODUCTION_CLAIM_READ_ONLY_PRECHECK_PASSED',
        liveSuccessfulNonrefundedPayment:true,
        merchantActiveSubscription:true,
        verifiedUnbannedNeonIdentity:true,
        matchingSingleLegacyPaidCustomer:true,
        paidThrough:proof.m.paidThrough,
        independentFreshBillingOtpRequired:true,
        independentProductionSignatureRequired:true,
        productionClaimPerformed:false
    });
}

export async function applyApprovedProductionPaidClaim({
    env,db,http=fetch,approval,operatorPublicKeyPem,now=()=>new Date()
}={}) {
    assertProductionClaimOperator(env);
    if(env.PRODUCTION_CLAIM_ACTION!=='APPLY_APPROVED_SINGLE_PAID_CLAIM' ||
       env.PRODUCTION_LOCAL_OWNER_CONFIRM!=='CLAIM_ONE_VERIFIED_PRODUCTION_SUBSCRIBER' ||
       !ENROLLED_PRODUCTION_APPROVER_FINGERPRINT) {
        throw Error('PRODUCTION_CLAIM_APPLY_DISABLED_UNTIL_SEPARATE_APPROVAL');
    }
    const context=await collectPreview({env,db,http,now:now()});
    const m=context.m;
    const proof=verifyIndependentProductionClaimApproval({
        approval,publicKeyPem:operatorPublicKeyPem,
        trustedFingerprint:ENROLLED_PRODUCTION_APPROVER_FINGERPRINT,
        expected:{
            issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId,
            customerId:m.customerId,paymentId:env.PRODUCTION_PAYMENT_ID,
            subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
            productId:context.subscription.product_id
        },now:now()
    });
    // Auth confirmation and Dodo billing mailbox challenge are INDEPENDENT.
    const otp=await readConsumedBillingChallenge({
        challengeId:proof.challengeId,issuer:m.issuer,subject:m.subject,
        db,now:now()
    });
    if(otp.customerId!==m.customerId ||
       otp.recipientEmail.trim().toLowerCase()!==m.billingEmail ||
       otp.recipientEmail.trim().toLowerCase()!==m.verifiedNeonEmail)
        throw Error('PRODUCTION_CLAIM_BILLING_OTP_OWNER_MISMATCH');

    const reviewer=makeTrustedDodoClaimReviewer({
        expectedIssuer:m.issuer,paymentId:env.PRODUCTION_PAYMENT_ID,
        subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
        productId:context.subscription.product_id,
        challengeId:proof.challengeId,apiKey:env.DODO_AUDIT_API_KEY,
        db,http,now
    });
    const reread=await reviewer({
        issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId
    });
    if(reread.verified!==true ||
       reread.evidenceReference!=='dodo-audit:'+proof.challengeId ||
       reread.paidThrough!==m.paidThrough)
        throw Error('PRODUCTION_CLAIM_FRESH_EVIDENCE_REJECTED');

    return linkLegacyPremiumAfterReview({
        issuer:m.issuer,subject:m.subject,legacyUserId:m.legacyUserId,
        reviewedBy:proof.reviewedBy,
        proofMethod:'dodo_merchant_manually_verified',
        evidenceReference:reread.evidenceReference,
        operatorApprovalReference:proof.approvalReference
    },reviewer,db);
}
