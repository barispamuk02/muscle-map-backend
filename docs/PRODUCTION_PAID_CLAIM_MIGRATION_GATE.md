# Issue #10: Production identity schema and single paid Premium claim

**Prepared in Backend Draft PR #2. NOT APPROVED TO WRITE PRODUCTION.**
Date: 2026-10-16. This document supersedes obsolete sections of older release readiness notes.

## Verified facts

- Sole confirmed real paying Premium owner; merchant LIVE latest $3.99 successful payment remains unrefunded. The earlier same-day $3.99 trial of real billing was **refunded**; a prior incomplete attempt was not paid.
- Production Auth Better Auth is independently provisioned on `br-odd-hat-b135xeiq`. The owner's Neon Console shows `emailVerified=true`, `banned=false`; actual recovery OTP and password sign-in worked. `allow_localhost=false`, `require_email_verification=true`, `https://muscle-map.app` trusted.
- Legacy Production `public` contains old users, payments, webhook_events, sample table only. Auth's managed `neon_auth` tables now exist; app `public.auth_identities`, `public.legacy_account_claims`, `public.legacy_account_claim_reversals`, `public.billing_email_challenges`, `public.payment_risk_events` do **not** yet exist in Production.
- Existing paid user is still under old ID. Dodo's merchant-confirmed paid-through date is **2026-11-14 04:23:24.489 UTC** in isolated STAGING reconciliation; Production legacy expires one day earlier. Do not modify either until a separately approved claim.
- Other two future-dated Premium records have not been proven to represent other real purchasers. Preserve both as-is.
- Frozen Neon Production checkpoint `br-icy-lake-b17jxntb` must not be modified. A same-project branch is not a substitute for an off-project export.

## Implemented Draft code, deliberately inactive

1. `production-auth-schema-migration.js`: independently pins **only** the actual Production Auth issuer and Neon direct/pooler host; requires `sslmode=verify-full`, refuses all STAGING hosts and unexpected environments. Read-only `inspectProductionAuthSchema()` prechecks duplicate merchant customer and payment IDs. `applyProductionAuthSchema()` adds missing identity/claim/OTP/risk tables and uniqueness indexes, without `UPDATE`, `DELETE`, `DROP` or truncation, **only after exact separate owner approval flags**. It is never invoked by the existing web server.
2. `production-paid-claim.js`: private operator `previewProductionPaidClaim()` performs *only* merchant Dodo LIVE GET and SQL SELECT, verifies exact payment/subscription IDs, one current successful **nonrefunded** $3.99 subscription, paid-through, a **single** historical Dodo-mapped legacy user and an independent `emailVerified=true`, unbanned Auth identity already initialized in `public.auth_identities`. The two unrelated legacy records are not involved.
3. `production-claim-approval.js`: uses a completely separate `muscle-map:production-premium-claim:v1` Ed25519 signature domain and pinned key fingerprint. **Production enrolled fingerprint is intentionally empty**. All live `applyApprovedProductionPaidClaim()` attempts currently fail closed even with STAGING keys. A separate Production-only encrypted signer must be enrolled under a future explicit approval.
4. Once separately authorized/enrolled, application requires a *fresh, separate Dodo billing email OTP* stored server-side and consumed once, a short-lived scoped operator signature, independent Dodo LIVE GET **re-read**, and reuses existing `linkLegacyPremiumAfterReview()` atomic SQL transaction. An account's Neon registration/recovery email OTP is **not** the billing ownership OTP. That claim updates **only the matching legacy subscriber's** identity mapping and possibly extends Premium to authenticated merchant paid-through, recording immutable audit. It does not create a new Dodo checkout, charge, refund, or subscription.

## Verified disposable rehearsal

`tests/production-release-gates.test.js` covers reject STAGING, weak TLS, environment mismatch, duplicate merchant ownership, refunded/failed payment, wrong Dodo customer, wrong IDs from GET, signed approval replay and expiration, and default write-disable.

`tests/production-auth-schema.integration.mjs` compiles and applies exactly the same DDL twice on a disposable PostgreSQL 16 `muscle_map_ci` database (not Neon). Asserts old users/paid expiry, payments and webhook counts/contents remain byte-equivalent. Refuses to run against Neon/STAGING/Production. Existing backend signed-claim atomic SQL rollback tests remain part of the same CI workflow.

## Gate for actual execution, in this order, separate authorization required

**Production schema only:** explicitly approve additive identity/OTP/claim/risk tables, no changes to existing legacy rows, paid dates, auth users or webhook history; confirm merchant ID uniqueness preflight. No rollback of Production live payments by restoring old branches.

**Owner identity:** after the schema is installed, initialize the single already verified Production Auth identity into `public.auth_identities` via authenticated Backend flow, creating an **unentitled** placeholder. This operation must be separately approved; an email string or an unverified localStorage ID cannot initialize a paid mapping.

**Merchant proof and transfer:** ensure Dodo LIVE GET shows the **later unrefunded successful** charge, its active subscription, matching verified Auth email and customer ID. Collect one fresh owner billing mailbox challenge (different from Neon Auth OTP). Independently enroll Production Ed25519 signing key, then obtain explicit approval to claim **exactly one** old Dodo-backed Premium account. Final signed transaction preserves or extends paid-through to merchant date, never shortens it, and keeps unrelated two rows untouched.

**Backend/Frontend rollout:** after the claim readback and owner Premium access are demonstrated, require another exact approval to change Production Render env, deploy, change auth enforcement or merge PRs. `PREMIUM_AUTH_REQUIRED=true` and `account-config.production.js` must **not** be turned on ahead of that step. Production Dodo webhook/refund handling and server-side paid enforcement remain separate release gates.

## Hard stop and recover

Stop on wrong host, missing verified Auth subject, no placeholder identity, merchant refund/dispute, mismatched Dodo identity, unexpected payment IDs, already claimed account, stale or unconsumed billing OTP, unknown operator signature or shortened paid-through. Roll back uncommitted SQL transactions, *not* the entire live Production branch. Never delete old Premium rows automatically.

**Permission in this turn:** draft GitHub code and CI only. No migration or claim in live Production, no Render deploy, no Dodo LIVE requests or payment mutations, and no backup changes.
