# Issue #10: Production identity schema and single paid Premium claim

## Production one-owner handoff ready for operator (2026-10-16)

**This is the current action status.** Production business-schema migration has ALREADY COMPLETED and is verified; the single paid Premium claim has NOT been applied. Backend remains Draft and unmerged.

An owner-controlled single-window Production transfer workflow is now implemented and continuously tested in the Draft branch:

- `production-owner-local-login.js`: only existing Neon Better Auth password sign-in and short-lived signed JWT retrieval. No repeat signup or recovery OTP.
- `production-owner-bootstrap.js` and `scripts/production-owner-operator.mjs`: independently validate a Production JWT, the existing `emailVerified=true`, non-banned Neon Auth row, and exact Production database host; optional **unentitled** identity initialization is blocked without specific approval.
- `production-operator-local-key.js`, `scripts/enroll-production-operator-key.mjs` and `scripts/run-production-key-enrollment.ps1`: create an **encrypted, distinct Production Ed25519 signing key on the owner's own Windows machine**, print only its **public SHA-256 fingerprint**. Do not copy the STAGING signing key, the private key or the passphrase into chat/GitHub.
- `scripts/run-production-one-paid-claim.ps1` and `scripts/production-one-owner-paid-claim.mjs`: one explicit owner-approved local session authenticates the existing verified identity, checks Dodo LIVE **GET-only** for the **later successful, nonrefunded** current subscription, verifies billing/identity email match and the unique existing paid legacy row, initializes exactly one unentitled placeholder, sends one independent Dodo billing ownership OTP, consumes it once, signs a scoped single-owner Production approval and atomically links **only that one** historic paid subscriber through existing `linkLegacyPremiumAfterReview()`. It reads back the resulting exact paid period with millisecond precision. None of these scripts is mounted as a public API. Failures stop; never blindly retry.
- **Intentional fail-closed boundary:** `ENROLLED_PRODUCTION_APPROVER_FINGERPRINT` remains EMPTY in `production-claim-approval.js`. The transfer runner will refuse to launch until the owner has locally generated the distinct encrypted key and its *public fingerprint* has been separately reviewed and pinned in a Draft commit. This is the next genuine owner interaction, not another round of signup or testing. The Production Auth password, Dodo audit key, Resend send-only key, OTP and Neon database credentials remain local/private.

When the owner is ready, in their existing checked-out Backend **Draft** branch `fix/issue-10-payment-ledger` on Windows, after `git fetch origin` and `git pull --ff-only`, run:

```powershell
powershell -NoProfile -File .\scripts\run-production-key-enrollment.ps1
```

This creates no Production DB writes or merchant requests. **The only value to share afterward is `PRODUCTION_PUBLIC_KEY_SHA256`** (64 hex characters). Never share the passphrase/private key. Once the public fingerprint is pinned and CI green, the final owner-controlled transfer uses **one terminal run**:

```powershell
powershell -NoProfile -File .\scripts\run-production-one-paid-claim.ps1
```

The second script will require a separate explicit terminal approval phrase for **both** unentitled placeholder creation and the one paid claim, plus entry of private credentials locally and the single fresh billing OTP. It does NOT modify Render Production, Dodo subscriptions, unrelated Premium accounts, Neon staging or the backup branch. It cannot run successfully before the owner has authorized the concrete Production paid transfer.

Prior migration counts and row hashes below remain the verified snapshot; no later Production business data changes have been made in this preparation.


## Applied Production business-schema migration: VERIFIED (2026-10-16)

**This section supersedes the earlier "prepared only" schema status below.** The user explicitly authorized ONLY additive Production public-schema DDL on Neon project `sparkling-sun-97014945`, branch `br-odd-hat-b135xeiq`, and expressly prohibited paid-claim changes, Dodo LIVE, Render deploys, backup edits and PR merges.

Execution used `mcp__Neon__run_sql_transaction` on `neondb` with the **exact 15 SQL statements** from `production-auth-schema-migration.js` in this Draft PR: five `CREATE TABLE IF NOT EXISTS`, four `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and six `CREATE INDEX IF NOT EXISTS` (including unique indexes). The existing `idx_users_dodo_customer` was already present, so `IF NOT EXISTS` preserved it. All statements succeeded atomically; no direct data DML executed. Before execution, Neon branch, database, full schema names and column types, absence of conflicting objects, and unique merchant customer/payment IDs were checked. Both duplicate counts were zero.

**Independent read-back:**
- All five required new `public` tables exist: `auth_identities`, `legacy_account_claims`, `legacy_account_claim_reversals`, `payment_risk_events`, `billing_email_challenges`.
- All six expected named indexes exist (including the original nonunique customer lookup index).
- New tables contain **zero rows** each; paid-user claim and identity-placeholder setup have **not** occurred.
- Unchanged: 3 legacy `public.users` rows, 3 future-dated active Premium rows, 0 `public.payments` rows, 2 `public.webhook_events` rows. Canonical MD5 snapshots of all rows (sorted by ID, `to_jsonb` projection) match exactly before and after:

| Table | Before and after fingerprint |
|---|---|
| `public.users` | `c2d833f49b4818eed67f0796a2f931f4` |
| `public.payments` | `d751713988987e9331980363e24189ce` |
| `public.webhook_events` | `f0af18154e7768d8a49257ac62cb7b0d` |

- Preserved backup `backup-production-pre-release-20261016` (`br-icy-lake-b17jxntb`) remains `ready`, unchanged parent LSN `0/28B19A0`. Production Render remains live on `87860a5015d950cf2097fa3d5bd3a897209b6b2c`. Neither Draft PR merged. No Dodo calls made.

**Next authorization boundary:** Initializing the one verified Production Auth account as an unentitled placeholder, fresh independent Dodo billing-email OTP, Production-only operator key enrollment, and atomic claim of exactly one legacy paid subscriber **are not authorized by this migration approval**. Do not run staging-only operator scripts against Production or infer payment ownership by email alone. A subsequent explicit approval must scope each live write and preserve the unrelated legacy Premium records.


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
