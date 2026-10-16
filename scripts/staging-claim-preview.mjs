/**
 * READ-ONLY local operator entrypoint. Never sends OTP, links accounts,
 * changes Premium, or verifies an admin key. No secrets printed.
 */
import pool from '../db.js';
import {previewStagingPremiumClaim,ENROLLED_OPERATOR_ED25519_FINGERPRINT} from '../staging-claim-operator.js';
try {
    const p=await previewStagingPremiumClaim();
    console.log('STAGING_PREMIUM_OPERATOR_PREVIEW=PASSED_READ_ONLY');
    console.log('MERCHANT_VERIFIED=YES');
    console.log('NEON_VERIFIED_LOGIN_AND_LEGACY_CUSTOMER_MATCH=YES');
    console.log('LEGACY_EXPIRY_MATCHES_MERCHANT='+(
        p.historicalExpiryMatchesDodo?'YES':(
            p.correctionInSameApprovedClaim?'NO_ATOMIC_CORRECTION_AVAILABLE':'NO_CONFLICT_REQUIRES_REVIEW'
        )
    ));
    console.log('FRESH_BILLING_OTP=REQUIRED_BEFORE_FUTURE_APPLY');
    console.log('OPERATOR_PUBLIC_FINGERPRINT_ENROLLED='+(
        ENROLLED_OPERATOR_ED25519_FINGERPRINT?'YES':'NO'
    ));
    console.log('SIGNED_OPERATOR_APPROVAL=REQUIRED_FOR_FUTURE_APPLY');
    console.log('PREMIUM_TRANSFER=NOT_PERFORMED');
} catch {
    console.error('STAGING_CLAIM_PREVIEW_REJECTED_NO_ACCOUNT_CHANGE');
    process.exitCode=1;
} finally {
    await pool.end();
}
