# Account-bound Premium, migration and payment rollout

Status: **staged implementation only**. This branch is a draft, not a production authorization system. Frontend remains a static PWA with legacy localStorage-based Premium gates.

## Verified-account API (new, inactive until integration)

- `GET /api/v2/me/premium` verifies an OAuth/OIDC-style **signed JWT access token** and uses its cryptographically verified `(iss, sub)` pair to resolve a server-created, random internal `userId`. It returns server-side Premium status and expiry.
- `POST /api/v2/me/checkout` does the same verification and attaches **only the server-resolved ID** to Dodo metadata. Supplying `userId` or `email` in the request body is rejected.
- Environment on the backend: `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` (HTTPS provider JWKS). JWT signature, audience, issuer and expiration are checked; only RS256/ES256 tokens are accepted. Set them to values from the chosen real provider, not placeholders.
- The dedicated `auth_identities` table stores the verified issuer, subject and internal ID, with a uniqueness constraint. No browser-controllable ID, email or Premium flag is accepted as ownership evidence.
- Without configured identity provider, the v2 API fails closed with 503. The old v1 API remains usable during migration. `PREMIUM_AUTH_REQUIRED=true` **disables both legacy ID-based Premium and checkout endpoints** and also prevents startup if identity provider config is absent. **Do not turn it on yet.**

**Important:** No identity provider was enabled/configured as part of this PR. Neon Auth was *not* enabled for the production branch as of 2026-10-16. Its current Better Auth session format must be verified for compatibility with an issuer/audience-signed JWT before choosing it for this implementation. Enabling `PREMIUM_AUTH_REQUIRED` today would strand all existing anonymous users and is forbidden.

## Legacy Premium migration: ownership must be proven

1. Deploy/test an actual login system for new users in an isolated staging environment and confirm signature verification, session expiry, refresh and logout behavior.
2. Keep the current three legacy Premium entries intact. Export only minimal mapping summaries for migration, **never** passwords, checkout secrets, card data, or full payment history to a browser.
3. For each legacy account, verify possession of the authenticated account *and* independent ownership of the Dodo customer/subscription (for example, a validated Dodo-managed customer portal verification or an out-of-band manually reviewed claim). Neither email equality nor knowledge of a legacy localStorage ID is sufficient.
4. Add a separate, transactional **admin-only** migration operation after the proof mechanism is chosen. Link the authenticated identity to the existing `users.id` without changing `premium_expires`; enforce one-to-one ownership and an auditable claim trail. This operation **does not exist yet**.
5. Verify checkout, Premium read, expiry, renewal, F5, logout/login, a different device, and conflicting/duplicate claims using isolated test records.
6. Only after existing subscribers are migrated, update the frontend to authenticated v2 calls and retire the v1 API by enabling `PREMIUM_AUTH_REQUIRED`. Confirm no user loses paid access.

## Dodo payment ledger and provider event policy

- The signed raw webhook and `webhook_events` ID remain the transport integrity/idempotency layer.
- Payment records use real `data.payment_id` as durable charge identity. Official Dodo payment webhooks mark this field required. **Missing/invalid charge ID fails the transaction**, rather than recording an unrelated payment for every `webhook-id`.
- A `payment.succeeded` event marked `is_update_payment_method: true` is not paid access and never grants Premium.
- A unique `payments.dodo_payment_id` index supplements deterministic `payments.id`. Concurrent event IDs for one charge must result in exactly one payment and one entitlement update.
- `subscription.active` is *not* a second paid ledger entry. Currently it may set entitlement from next billing date, so ordering and plan compatibility still require real Dodo payload tests.
- `payment.failed`, cancellation and delayed expiry must not erase a valid already-paid period. Current implementation does not implement a complete refund/dispute/chargeback state machine; **do not mark Issue #10 done**.
- Real payment webhooks may have `service_periods`, while subscription events have `next_billing_date`. Before production, confirm monthly period calculation against actual Dodo event samples, and do not silently invent a period for unsupported payloads.
- Reconcile the two older `payment.succeeded` webhook records with Dodo LIVE transaction records; do not fabricate historical ledger rows to match a desired count. Missing user/subscription matches should remain retryable and visible to an operator.

Official references:
- https://docs.dodopayments.com/developer-resources/webhooks
- https://docs.dodopayments.com/developer-resources/webhooks/intents/payment
- https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription
- https://docs.dodopayments.com/developer-resources/webhooks/intents/refund

## Server-only security boundary

The server controls authenticated checkout identity and API-retrieved entitlements; the existing static frontend still loads PDF and feature logic into the browser. Changing a client-side `isPremium()` function can bypass UI controls; **these are not secured by this PR**. Future paid server workloads must check the identity's entitlement on *every* request and deliver the protected output from the backend.

## QA and production gate

1. Keep this PR as a **Draft**; run all unit tests and disposable PostgreSQL 16 integration tests, including duplicate/concurrent charges and account identity isolation.
2. Create a disposable Neon branch, test schema migration and auth provider integration against isolated records. Do **not** enable Neon Auth on production while experimenting.
3. Review real Dodo samples, refund behavior, billing periods, service errors and response codes.
4. Complete and test login UI, verified legacy account claims and server-enforced premium-only services before changing the legacy API switch.
5. Document privacy and retention: store only provider issuer/subject, internal IDs and minimal payment audit fields; establish a retention/deletion process compatible with mandatory financial records. No unencrypted secrets or card details belong in logs, source code or PostHog.
6. Set a manual maintenance/deploy window. Render Auto-Deploy stays **OFF**. Take a verified rollback point and monitor Dodo delivery failures, identity errors, ledger duplicates and lost entitlements after deployment. No live charge/refund test without explicit approval.

No deployment, production database migration, or real Dodo charge is part of this Draft PR.
