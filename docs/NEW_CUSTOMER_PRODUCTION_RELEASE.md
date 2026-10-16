# Muscle Map: new customer commercial release (2026-10-16)

**Purpose:** make a NEW verified Neon Auth user pay Dodo and automatically receive Premium.
**Owner's one-off legacy paid/test-account claim is NOT part of this release and is NOT a launch prerequisite.**
Do not run `scripts/run-production-one-paid-claim.ps1`, request its secrets or
send a Dodo ownership OTP for this release. The old paid/test rows stay untouched.

## Current evidence, not just assumptions

- Production Render `srv-db29eduk1f9s739kr6jg` serves old main commit `87860a5`;
  `PREMIUM_AUTH_REQUIRED` cutover is not deployed.
- Backend PR #2 and frontend PR #11 remain DRAFT and unmerged.
- Public frontend main links `account.html` but has not shipped that file.
- Neon Production branch `br-odd-hat-b135xeiq` has a distinct managed Better Auth
  issuer; `require_email_verification=true`, `allow_localhost=false`;
  trusted origin `https://muscle-map.app`. `verify_email_on_sign_up=false`
  is a separate field and must not be conflated with
  `require_email_verification=true`.
- Additive public account/claim tables already exist in Production. Historical
  paid/test rows remain intact. NEW verified users get their own rows via
  `getAccountUserId` when calling a signed protected endpoint.
- CI covers signed HTTP JWT verification and PostgreSQL simulation of a NEW
  buyer -> merchant payment -> premium entitlement -> duplicate suppression.
  No real new customer has bought through the new Production cutover yet.
- Production static Premium feature limits are client-side convenience gating,
  NOT a cryptographically enforced paywall for downloaded code/assets.

## New buyer contract

1. Browser opens `account.html` with public production-only
   `account-config.js` (copy of reviewed release template, **never staging config**).
2. Neon verifies email and signs the short-lived login JWT.
3. `GET /api/v2/me/premium` checks JWT, emailVerified and banned state,
   then maps the subject to a new random server-side `users.id` through
   `auth_identities`.
4. `POST /api/v2/me/checkout` takes NO `userId` or `email` from the client;
   it uses the same authenticated server account ID and creates a Dodo
   checkout with `metadata.user_id` equal to that ID.
5. A genuine signed `payment.succeeded` webhook atomically inserts payment
   and event ledger rows, matches merchant customer to the account, and
   grants Premium through the Dodo service_periods paid-through timestamp.
   Retried/duplicate events must not duplicate paid time or payments.
6. Authenticated `GET /api/v2/me/premium` reports the entitlement; frontend
   `isPremium()` trusts that protected response, never localStorage.
   A Dodo checkout URL is not evidence of a completed payment.

## Remaining mandatory release actions (EXPLICIT OWNER APPROVAL REQUIRED)

- Review latest passing checks on both Draft PR heads. Confirm no competing
  production commits or incompatible service worker/config changes.
- Review and prepare production Backend Render environment: the existing real
  Dodo webhook secret and API key, pinned Production Neon issuer and JWKS,
  nonpooled `DATABASE_URL` with `sslmode=verify-full`, exact origin and
  no STAGING auth or merchant secrets. Do not read or echo secret values.
- Merge/deploy reviewed Backend PR with `PREMIUM_AUTH_REQUIRED=false`
  initially and production issuer configured, so old checkout is not
  abruptly disabled while the new Frontend is not live.
- For a coordinated cutover, enable `PREMIUM_AUTH_REQUIRED=true`
  with `APP_ENV=production` and all strict
  `production-auth-rollout-guard.js` pins; publish the Frontend PR with
  `account-config.js` equal to the reviewed Production config.
  Avoid a long window where auth-only Backend faces old client checkout.
- Validate live **read-only** endpoints, trusted origin, new anonymous 401,
  verified subject 200, paid/unpaid Premium UI, Dodo webhook configured and
  possible pending paid state after the hosted checkout returns.
  Real money verification requires separate, explicitly authorized
  controlled live checkout; it is NOT performed by these steps.
- Retain rollback to previous code/config. Do not overwrite Production DB
  with its earlier backup while LIVE webhook payments may have arrived.

## Never use as a blocker

The owner's single genuine old Dodo paid subscription and two other
development/test Premium records need **no transfer or deletion** for
NEW buyer Neon Auth to work. The owner can be granted a separately designed,
server-controlled developer entitlement later if desired.
