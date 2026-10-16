# Account-bound Premium, migration and payment rollout

Status: **staged implementation only**. This branch is a draft, not a production authorization system. Frontend remains a static PWA with legacy localStorage-based Premium gates.

## Verified-account API (new, inactive until integration)

- `GET /api/v2/me/premium` verifies an OAuth/OIDC-style **signed JWT access token** and uses its cryptographically verified `(iss, sub)` pair to resolve a server-created, random internal `userId`. It returns server-side Premium status and expiry.
- `POST /api/v2/me/checkout` does the same verification and attaches **only the server-resolved ID** to Dodo metadata. Supplying `userId` or `email` in the request body is rejected.
- Environment for **Neon Managed Better Auth**: `AUTH_PROVIDER=neon`, `AUTH_ISSUER` equal to the Neon Auth URL **origin** (not its `/neondb/auth` path), `AUTH_JWKS_URL` from the matching Neon branch. Neon JWTs use **EdDSA** and typically no stable `aud` claim: verify issuer, EdDSA signature, expiry and subject; `AUTH_AUDIENCE` is not required in this mode. For independent OIDC providers, `AUTH_PROVIDER` omitted, `AUTH_AUDIENCE` is required and RS256/ES256 only. Do not mix staging JWKS and production tokens.
- The dedicated `auth_identities` table stores the verified issuer, subject and internal ID, with a uniqueness constraint. No browser-controllable ID, email or Premium flag is accepted as ownership evidence.
- Without configured identity provider, the v2 API fails closed with 503. The old v1 API remains usable during migration. `PREMIUM_AUTH_REQUIRED=true` **disables both legacy ID-based Premium and checkout endpoints** and also prevents startup if identity provider config is absent. **Do not turn it on yet.**

**Important:** No identity provider was enabled/configured as part of this PR. Neon Auth was *not* enabled for the production branch as of 2026-10-16. Its current Better Auth session format must be verified for compatibility with an issuer/audience-signed JWT before choosing it for this implementation. Enabling `PREMIUM_AUTH_REQUIRED` today would strand all existing anonymous users and is forbidden.

## Legacy Premium migration: ownership must be proven

1. Deploy/test an actual login system for new users in an isolated staging environment and confirm signature verification, session expiry, refresh and logout behavior.
2. Keep the current three legacy Premium entries intact. Export only minimal mapping summaries for migration, **never** passwords, checkout secrets, card data, or full payment history to a browser.
3. For each legacy account, verify possession of the authenticated account *and* independent ownership of the Dodo customer/subscription (for example, a validated Dodo-managed customer portal verification or an out-of-band manually reviewed claim). Neither email equality nor knowledge of a legacy localStorage ID is sufficient.
4. Internal-only transactional function `linkLegacyPremiumAfterReview` in `legacy-account-claim.js` has been added and is **not exposed over HTTP**. It requires independent Dodo ownership validation from a trusted operator-supplied callback, an exact Dodo customer ID match to the preexisting subscriber record, an initialized verified identity, uniqueness constraints, and an audit entry in `legacy_account_claims`. It preserves `premium_expires` and forbids silently absorbing a newly paid account. **The independent evidence-collection/reviewer workflow has not yet been implemented or carried out; never treat callback parameters as proof by themselves.**
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

As of 2026-10-16, staging Neon branch `br-jolly-sunset-b1pl23nn` (`staging-issue10-auth-20261016`) has Managed Better Auth, but production Neon does not. A read-only audit of this branch: 3 existing Premium users, only 2 with a stored Dodo customer ID. The third needs separate customer/payment reconciliation and cannot use automatic legacy linking. Frontend staging implementation: frontend Draft PR #11. No production account is registered or bound by these changes.

No deployment, production database migration, or real Dodo charge is part of this Draft PR.


## Historical Dodo subscription ownership: operator review procedure (2026-10-16)

**No automatic customer claim is enabled.** There are three historical active Premium rows, two with a Dodo customer ID and one without. This procedure covers verified billing ownership, not guesses based on cached browser identifiers.

### Eligible proof
1. The customer first signs in through a **verified** Neon Auth identity; the backend validates JWT signature/issuer and the account's `neon_auth.user.emailVerified` state. A self-reported email or unsigned browser localStorage token is not proof.
2. A reviewer retrieves the **exact Dodo customer/subscription/payment record** from Dodo's authenticated **LIVE merchant dashboard or API**, checking successful payments, the subscription's actual paid period, customer ID, and billing contact. Never retrieve this information from unverified browser input. Do not paste API keys or full customer information into GitHub.
3. Reviewer requires an **independent subscriber-possession check**, such as a single-use challenge delivered by the merchant through a trusted channel to the *billing email on Dodo's record*, not a customer-supplied address. The applicant must complete it while authenticated as their Neon identity. The challenge implementation and mail delivery are **not yet built**. A customer portal link is **not** a claim proof: merchant-generated links can be opened by anyone holding the link.
4. Two reviewers or an authenticated admin-only process record the decision with a private ticket reference; verify there is no competing claim. Historical Dodo activity must match the legacy row's `dodo_customer_id`, including any cancellation/chargeback disposition.
5. Only after evidence passes, a trusted backend operator can call the **internal function** `linkLegacyPremiumAfterReview` using a callback that verifies evidence from the operator's trusted records. The callback must NOT simply return `{verified:true}` based on untrusted claimant-supplied values. The transaction atomically maps the verified identity to the legacy paid user, retains `premium_expires`, writes `legacy_account_claims`, and denies duplicates and paid-account collisions.
6. For the third legacy record lacking `dodo_customer_id`: **stop**. First reconcile signed webhook IDs with authoritative Dodo merchant transactions to restore the customer mapping. No transfer until corroborated.
7. Issue a confirmation to the affected subscriber and verify the original account and its paid expiry remain accessible. Monitor claim failures and provide a reversible admin-only recovery process before production.

### Explicitly unacceptable evidence
- User-controlled `muscleMap_userId` or `muscleMap_premium`.
- Email equality by itself, screenshot, guessed customer ID, pasted invoice text, or a Dodo portal URL.
- Merchant-generated Dodo portal `send_email=true` alone without a completed proof, since requesting a delivery is not evidence that the requester is the recipient.
- Test/sandbox Dodo transaction as proof of a LIVE paid entitlement.

### Neon email verification release blocker
Managed Neon Auth supports mandatory email verification (OTP) at the **Neon Auth Email & Password configuration**, including `require_email_verification`, `verify_email_on_sign_up` and `verify_email_on_sign_in`. The currently available Neon connector exposes **read/configure application name**, but does not expose the separate email/password settings PATCH operation. Therefore these flags have **not** been changed via the connector. Until an authorized operator switches them for the **staging** branch in Neon Console and tests actual email delivery/code redemption with an inbox, the end-to-end email challenge remains **unverified**. Do not switch production or retire legacy API.
The backend Draft PR now supports `REQUIRE_EMAIL_VERIFICATION=true` to reject Neon-authenticated but unverified users at **all protected v2 entry points**, with the authoritative `emailVerified` value read from the Neon Auth schema. The isolated HTTP integration test uses a disposable PostgreSQL fixture for that property. Test-fixture promotion to true does NOT itself constitute a real verification email.
Frontend Draft PR #11 contains the OTP input/resend/verify UI, controlled by `emailVerificationRequired` in `account-config.js`. It remains false until Neon genuinely requires verification.

References:
- Neon API settings: https://api-docs.neon.tech/reference/updateneonauthemailandpasswordconfig
- Better Auth OTP endpoints: https://better-auth.com/docs/1.6/plugins/email-otp
- Dodo portal API: https://docs.dodopayments.com/api-reference/customers


## 2026-10-16: calendar billing correction and isolated claim rehearsal

The Dodo merchant dashboard showed an October 14 successful monthly charge whose subscription's next billing date is **November 14**, while the old backend had granted until **November 13** because it had fallen back to **now + 30 days**. This is a provider billing-period mismatch, **not** authority to rewrite live records without a verified subscription period.

### Billing implementation, Draft PR only

- The only automatic **paid** entitlement-activating webhook is `payment.succeeded`, with a **single, correctly linked** entry in `service_periods` carrying explicit `starts_at`, `ends_at`, `subscription_id`, matching `subscription_ids`.
- Reject missing, ambiguous, malformed, stale, implausibly distant or mismatched periods; the webhook marker and payment transaction must roll back for future reconciliation/retry. Never substitute calendar arithmetic (30 days, 31 days, plus one month) when Dodo does not supply paid-period proof.
- `subscription.active` only records receipt of an account-state notification and does **not** grant premium or create a payment charge.
- Card-method-only events and unsubscribed/on-demand charges cannot grant Premium.
- Existing `setPremium` retains the greater of old and verified new period, so a late event must not reduce a valid already-paid term. Refund/dispute/chargeback handling remains a separate **release blocker**.
- Official payload description: Dodo Payment webhook `service_periods[].ends_at` and Subscription `next_billing_date` (end of billing period). See https://docs.dodopayments.com/developer-resources/webhooks/intents/payment and https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription.

### Verification and isolated staging rehearsal

- GitHub Actions `Backend Payment Ledger Regression` run `38851424665`: **success** (Node unit and real disposable PostgreSQL 16 ledger tests including 31-day Oct→Nov billing, duplicate charge protection, transaction rollback). `Isolated Auth HTTP E2E` run `38851424641`: **success**.
- Staging preflight (read-only): 1 eligible historic paid customer row, 1 authenticated login-to-unentitled-user mapping, 0 existing claims, 0 ownership collisions; **this is NOT owner proof**.
- A **separate Neon child branch** `staging-migration-rehearsal-20261016` (`br-frosty-pine-b15rsdc6`) was cloned from staging. Two **synthetic accounts**, a synthetic auth identity and a synthetic `legacy_account_claims` audit record were inserted in a single transaction, then the synthetic identity was mapped to the synthetic paid account.
- Post-rehearsal checks: exactly 1 synthetic mapping, exact preserved synthetic expiry, exactly 1 claim. Original staging branch still shows 4 users / 0 claims; production still shows 3 users / 3 active Premium with no migration.
- The SQL rehearsal checks schema and transactional mapping only; the **actual internal application function** `linkLegacyPremiumAfterReview` is separately tested in the disposable PostgreSQL CI runner, including rejection of a mismatching customer and duplicate claims.
- **No real subscriber was migrated**. Before real staging migration, implement a trusted ownership verifier for the Dodo billing account (independent challenge and merchant-side proof). Existing photos or e-mail matching alone are not a binding authorization, and fake CI `verified:true` callbacks must never be used on a real account.
- No Dodo subscription, payment, LIVE credential, Neon production row, Render production service or frontend production branch was modified.

### Rollout gates

Keep PR #2 Draft, frontend PR #11 Draft and Render Auto-Deploy OFF. Before manual staging redeploy, review the strict billing change and test with sanitized authentic Dodo `payment.succeeded` payload schema. Then finish refund/dispute handling, ownership verification flow, staging real-account claim approval and production rollback planning. **Do not backfill a historical payment row or extend the owner's Premium purely from a screenshot.**
