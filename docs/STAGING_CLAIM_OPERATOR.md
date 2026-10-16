# Isolated Neon STAGING Premium claim: privileged local operator

Status **PREVIEW-ONLY**. Source is on backend Draft PR #2. No real staging customer has been linked. No public HTTP route, browser feature, Render job or production command exposes claim execution.

## Why the preview and apply are separate

The owner previously independently verified a Dodo LIVE USD 3.99 subscription and confirmed billing mailbox ownership with a one-time email code. That challenge is durable evidence of a historical confirmation but **stale** for a new claim (10-minute maximum). The independent Neon STAGING database still has no real claims. Do not send another OTP until immediate authorized claim execution is genuinely ready.

One paid legacy row has a shorter stored expiration than the authoritative Dodo paid-through date: **2026-11-14T04:23:24.489Z**. This cannot be silently edited. The staging apply guard refuses the transfer while the stored date differs from merchant evidence. Any expiry reconciliation is a distinct owner-approved, audited operation with its own validation.

## Current operation: READ-ONLY preview

From the isolated local backend checkout, after pulling Draft branch:

    powershell -NoProfile -File .\scripts\run-staging-claim-preview.ps1

This script verifies it is running in the exact draft branch, accepts the STAGING DATABASE_URL, read-only Dodo Audit Key, successful Payment ID and active Subscription ID through hidden PowerShell prompts, then calls scripts/staging-claim-preview.mjs.

The Node entrypoint:
1. Requires APP_ENV=staging, exact staging Neon host and Neon Auth issuer. Refuses production Dodo write/webhook credentials.
2. Makes two authenticated **GET-only** Dodo LIVE calls (payment and subscription).
3. Validates real successful, nonrefunded USD 3.99 payment, expected product, subscription linkage and paid-through period.
4. Uses PostgreSQL **SELECT** only to match one paid legacy customer and one verified unbanned Neon Auth identity with an empty Premium placeholder. Checks there are no competing claims or payment collisions.
5. Separately checks the existing paid record expiry against the Dodo paid-through date, returning a sanitized discrepancy status.
6. Prints only status labels; no customer email, password, payment/subscription/customer IDs or connection string. Does not send OTP or perform any database writes.

If checks fail, preview stops. After completion, the launcher clears the temporary environment variables. Never post keys, customer identifiers, paid email, challenge ID or OTP into ChatGPT, GitHub or logs.

## FUTURE privileged apply: disabled until enrollment and separate authorization

The unexposed function applyApprovedStagingPremiumClaim in staging-claim-operator.js is coded but **hard-disabled** by ENROLLED_OPERATOR_ED25519_FINGERPRINT=null.

A later, separately approved owner enrollment must register a trusted administrator Ed25519 **public key fingerprint** in reviewed source configuration. Only the public key may be shared for enrollment; the administrator's **private signing key must never leave the administrator's computer** and must not be placed in chat, a repository, logs or cloud configuration.

The future operator must:
- Independently verify a genuine signed-in Neon Auth subject and current non-banned verified email;
- Recheck the merchant payment and subscription by authenticated LIVE Dodo GET;
- Resolve, with a separate explicit owner-approved auditable action, the mismatch between historical expiry and merchant paid-through;
- Send a **fresh** independent billing-email OTP to the Dodo billing address, then confirm it within the same secure local session;
- Have an independent enrolled administrator sign an **exact, short-lived** staging-only approval envelope. The Ed25519 signature binds issuer, subject, legacy account, Dodo customer/payment/subscription/product IDs, consumed challenge ID, reviewer, random nonce and issuance/expiry timestamps. Approval expires within **5 minutes**;
- Require explicit operator apply mode and conduct merchant + OTP verification again immediately before a single transactional claim. A SHA-256 signature reference is stored on the durable claim audit with a unique index, so an approval cannot be silently reused for another link.
- Verify migrated account entitlement, original customer mapping and audit state after the mutation. Keep a reviewed rollback plan, and do not automatically reverse if a new payment or expiry update has occurred.

The signing-key enrollment, real operator-signing workflow, real apply CLI, claim-time production-grade admin authentication, separate historical-expiry reconciliation and rollback rehearsal using a dedicated database backup are **NOT YET completed**. No actual APPLY may be attempted until each prerequisite is reviewed and the owner explicitly approves the named staging action.

## Test coverage

- tests/staging-claim-operator.test.js verifies environment isolation, merchant GET and Neon SELECT only, Dodo/legacy expiry mismatch detection, wrong merchant state, exact Ed25519 signature validation and invalid/expired/mismatched unsigned or mis-signed approvals;
- Production credentials and wrong database hosts are rejected;
- Applying without enrolled trusted administrator key rejects **before any Dodo or database request**;
- tests/legacy-claim-rollback.integration.mjs already verifies transactional forward/rollback against disposable PostgreSQL, including conflict and injected-failure cases.

Run only via GitHub Actions or disposable local test DB. Never run integration tests against Neon staging or production.

## Important boundaries

The draft code is **not a live secure admin UI**. The signed approval validator and transaction primitives are readiness components, but independent public-key enrollment and privileged operator identity must be deliberately configured in a later separately authorized step. Neither premium entitlements nor historical paid records have been touched by this task.
