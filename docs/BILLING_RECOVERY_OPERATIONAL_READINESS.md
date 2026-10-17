# Commercial release: billing and recovery operations

This checklist does **not** create accounts, run a checkout, or change Production data.

## Recovery
The production account page uses Neon Better Auth `/email-otp/request-password-reset` and `/email-otp/reset-password`. Existing sessions and paid entitlements are verified server-side against Neon Auth identity. Before announcing recovery E2E as passed, perform one owner-initiated recovery on an existing account in an authorized browser. Never send OTP, password, JWT or recovery email contents to an assistant, issue or log.

## Subscription behavior
- Only a signed, validated `payment.succeeded` for a positive USD subscription charge grants/extends paid-through access.
- `subscription.active` does not prove payment.
- `subscription.expired` checks that paid-through time elapsed before expiry.
- Cancellation does not remove the remaining paid period.
- Signed refund/dispute events are recorded in `payment_risk_events` for review. They **do not** currently auto-revoke a subscription: identify the exact refunded charge and any later renewals first.

## Read-only operational monitor
Run `node scripts/check-billing-health.js` in a trusted environment using existing, securely injected production `DATABASE_URL`; never print the value. The tool reads only aggregate counts; no database writes or Dodo API requests. Exit 0 means no pending risk events, 2 indicates manual refund/dispute review required, 1 indicates monitoring failure. Do not infer that exit 0 means checkout works or no webhook is missing.

Suggested follow-up: configure approved scheduled execution and alerts to an owner-controlled channel. A scheduled monitor is not installed by this PR.

## Go-live acceptance gaps
1. Verify actual password recovery E2E with the owner's existing account when authorized, without exposing OTP.
2. Confirm expiry and renewal on isolated PostgreSQL/CI fixtures; do not make extra LIVE payments.
3. Confirm prospective Dodo webhook delivery and alerting; review queued risk events before any manual entitlement adjustment.
4. Production smoke: unauthenticated paid endpoint returns 401; paid account gets 200; Free 403 remains CI-backed until tested with a genuine Free account.
