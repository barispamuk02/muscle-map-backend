/**
 * READ-ONLY local operator entrypoint. Never sends OTP, links accounts,
 * changes Premium, or verifies an admin key. No secrets printed.
 */
import pool from '../db.js';
import {previewStagingPremiumClaim} from '../staging-claim-operator.js';
try {
    const p=await previewStagingPremiumClaim();
    console.log('STAGING_PREMIUM_OPERATOR_PREVIEW=PASSED_READ_ONLY');
    console.log('MERCHANT_VERIFIED=YES');
    console.log('NEON_VERIFIED_LOGIN_AND_LEGACY_CUSTOMER_MATCH=YES');
    console.log('LEGACY_EXPIRY_MATCHES_MERCHANT='+(
        p.historicalExpiryMatchesDodo?'YES':'NO_RECONCILIATION_REQUIRED'
    ));
    console.log('FRESH_BILLING_OTP=REQUIRED_BEFORE_FUTURE_APPLY');
    console.log('INDEPENDENT_SIGNED_ADMIN_APPROVAL=NOT_YET_ENROLLED');
    console.log('PREMIUM_TRANSFER=NOT_PERFORMED');
} catch {
    console.error('STAGING_CLAIM_PREVIEW_REJECTED_NO_ACCOUNT_CHANGE');
    process.exitCode=1;
} finally {
    await pool.end();
}
