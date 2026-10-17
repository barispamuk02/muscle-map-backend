// Read-only production billing audit. Never makes checkout calls or changes data.
// Run with existing DATABASE_URL: node scripts/check-billing-health.js
import pool from '../db.js';

try {
    const {rows:[row]}=await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM payment_risk_events
           WHERE review_status='pending') AS pending_risk_events,
          (SELECT COUNT(*)::int FROM payment_risk_events
           WHERE review_status='pending' AND matched_payment_user_id IS NULL) AS unmatched_risk_events,
          (SELECT COUNT(*)::int FROM payments) AS recorded_payments,
          (SELECT COUNT(*)::int FROM billing_subscription_owners) AS subscription_owners,
          (SELECT COUNT(*)::int FROM users
           WHERE premium_expires > NOW()) AS currently_entitled_users
    `);
    const safe={
        checkedAt:new Date().toISOString(),
        pendingRiskEvents:row.pending_risk_events,
        unmatchedRiskEvents:row.unmatched_risk_events,
        recordedPayments:row.recorded_payments,
        subscriptionOwners:row.subscription_owners,
        currentlyEntitledUsers:row.currently_entitled_users
    };
    // Only aggregate counts, never JWTs, addresses, payment IDs or sensitive payloads.
    console.log(JSON.stringify(safe));
    if(safe.pendingRiskEvents>0) {
        console.error('REVIEW REQUIRED: Dodo refund/dispute records pending human reconciliation.');
        process.exitCode=2;
    }
} catch (error) {
    console.error('Billing health read failed:',error.code || error.name || 'unknown');
    process.exitCode=1;
} finally {
    await pool.end();
}
