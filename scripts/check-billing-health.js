// Read-only production billing audit. Never makes checkout calls or changes data.
// Run with existing DATABASE_URL: node scripts/check-billing-health.js
import pool from '../db.js';
import {evaluateBillingHealth} from '../billing-health.js';

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
    const safe={checkedAt:new Date().toISOString(),...evaluateBillingHealth(row)};
    console.log(JSON.stringify(safe));
    if(safe.needsReview) {
        console.error('REVIEW REQUIRED: Dodo refund/dispute records pending human reconciliation.');
        process.exitCode=2;
    }
} catch (error) {
    console.error('Billing health read failed:',error.code || error.name || 'unknown');
    process.exitCode=1;
} finally {
    await pool.end();
}
