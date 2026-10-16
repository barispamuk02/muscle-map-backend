# Isolated Neon STAGING Premium claim: privileged local operator

Status **PUBLIC FINGERPRINT ENROLLED, NO LIVE APPLY CLI**. Source is on backend Draft PR #2. No real staging customer has been linked. No public HTTP route, browser feature, Render job or production command exposes claim execution.

## Why the preview and apply are separate

The owner previously independently verified a Dodo LIVE USD 3.99 subscription and confirmed billing mailbox ownership with a one-time email code. That challenge is durable evidence of a historical confirmation but **stale** for a new claim (10-minute maximum). The independent Neon STAGING database still has no real claims. Do not send another OTP until immediate authorized claim execution is genuinely ready.

One paid legacy row has a shorter stored expiration than authoritative Dodo paid-through **2026-11-14T04:23:24.489Z**. The guarded claim now **corrects this positive difference inside the SAME transaction** as the approved identity link, without shortening existing entitlements. Its audit stores both pre-link and merchant-confirmed post-link dates. Reversal restores only the original identity mapping and preserves the paid-through extension. If legacy expiry exceeds verified Dodo paid-through, the claim stops for review. No separate date-only DB write is needed.

## One-session owner-approved STAGING migration

The owner has approved **one existing paid Premium entitlement transfer in isolated Neon STAGING only**. Public Ed25519 fingerprint is pinned in this draft branch; the passphrase and encrypted private key remain on the owner's Windows computer.

From the `muscle-map-billing-audit-local` checkout on `fix/issue-10-payment-ledger`:

    git pull --ff-only
    powershell -NoProfile -File .\scripts\run-staging-premium-transfer.ps1

The single PowerShell session:
1. Verifies the previously created local Ed25519 key, before sending any email.
2. Accepts STAGING Neon URL, Dodo LIVE **GET-only** audit API key, Resend send-only key and the existing successful Dodo Payment/Subscription IDs through hidden inputs.
3. Checks merchant ownership and independently verified Neon login, then sends exactly **one fresh** email OTP only after terminal confirmation `SEND`.
4. Confirms that email code within 10 minutes, then requests a single explicit terminal `APPLY STAGING` before any entitlement write.
5. Creates a 3-minute operator-signed approval covering exact merchant and verified customer/Neon identity, consumed challenge, reviewer, nonce and times.
6. Re-fetches authenticated Dodo payment and subscription, independently re-reads consumed OTP, then atomically binds the verified Neon sign-in to the existing legacy paid row and extends the historical shorter expiry to Dodo's paid-through date.
7. Re-reads the mapped identity, stored verified paid-through, Dodo customer and durable approval audit, then returns only sanitized status messages.

The STAGING database has already received **non-destructive schema additions** (claim snapshot and approval fields, unique approval index, rollback audit table). Historical claims and paid entitlements were unchanged by this preparation. GitHub Actions uses disposable PostgreSQL; never supply real connection strings to CI.

Do not retry if the final operator apply reports an unknown result: it may have committed despite a readback problem. Instead inspect STAGING claims read-only. The operation requires no production API keys, billing writes, PR merge or deployment.

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

## FUTURE privileged apply: enrolled local key, pending operator workflow and separate authorization

The internal function applyApprovedStagingPremiumClaim in staging-claim-operator.js now pins the owner-provided **public fingerprint** `68dc0b78c07acaa3e3e867744fcfa7f06182852140be02a52fa18dab6a079cac`. It still requires exact local operator APPLY mode, valid time-limited signed approval bound to the OTP, and fresh independently verified Dodo billing evidence. Only the local owner-controlled PowerShell launcher can execute the staging-only CLI; no network API route or cloud service exposes it.

The operator encrypted Ed25519 private key is stored on the owner's Windows workstation. Only its SHA-256 **public** fingerprint is pinned in reviewed draft source configuration; the private signing key and its passphrase must never leave the operator's computer or enter chat, repository, logs or cloud configuration. Pinned fingerprint is not an approval for a real database mutation.

The future operator must:
- Independently verify a genuine signed-in Neon Auth subject and current non-banned verified email;
- Recheck the merchant payment and subscription by authenticated LIVE Dodo GET;
- Allow the authenticated Dodo paid-through to extend the shorter historical expiry atomically with the reviewed claim, retaining before/after snapshots;
- Send a **fresh** independent billing-email OTP to the Dodo billing address, then confirm it within the same secure local session;
- Have an independent enrolled administrator sign an **exact, short-lived** staging-only approval envelope. The Ed25519 signature binds issuer, subject, legacy account, Dodo customer/payment/subscription/product IDs, consumed challenge ID, reviewer, random nonce and issuance/expiry timestamps. Approval expires within **5 minutes**;
- Require explicit operator apply mode and conduct merchant + OTP verification again immediately before a single transactional claim. A SHA-256 signature reference is stored on the durable claim audit with a unique index, so an approval cannot be silently reused for another link.
- Verify migrated account entitlement, original customer mapping and audit state after the mutation. Keep a reviewed rollback plan, and do not automatically reverse if a new payment or expiry update has occurred.

The local signing-key enrollment and public fingerprint pinning are COMPLETE. The local operator-signing workflow and one-session STAGING apply CLI are implemented. Owner confirmation, fresh billing email verification, and privately signed approval are required for each execution. Rollback infrastructure has disposable PostgreSQL regression coverage; a full backup-based rehearsal is not yet completed. The owner has approved the isolated STAGING action, but a live transfer still needs fresh OTP and the owner's local encrypted key. Production remains out of scope.

## Test coverage

- tests/staging-claim-operator.test.js verifies environment isolation, merchant GET and Neon SELECT only, Dodo/legacy expiry mismatch detection, wrong merchant state, exact Ed25519 signature validation and invalid/expired/mismatched unsigned or mis-signed approvals;
- Production credentials and wrong database hosts are rejected;
- Applying without explicit local operator APPLY mode rejects **before any Dodo or database request**, even with the pinned fingerprint;
- tests/legacy-claim-rollback.integration.mjs already verifies transactional forward/rollback against disposable PostgreSQL, including conflict and injected-failure cases.

Run only via GitHub Actions or disposable local test DB. Never run integration tests against Neon staging or production.

## Important boundaries

The draft code is **not a live secure admin UI**. The signed approval validator and transaction primitives are readiness components, but the private key remains local and the privileged operator process requires fresh OTP and local consent. Neither premium entitlements nor historical paid records have been touched by this task.

## Streamlined staging claim, 2026-10-16

The legacy November 13 vs merchant November 14 difference is now reconciled as part of the **same privileged, OTP-backed atomic claim**, not as a separate preparatory mutation. The database audit stores premium_expires_at_claim and premium_expires_after_claim; rollback checks the latter and does not shorten the customer's legitimately paid period. New regression tests use disposable PostgreSQL only. The actual APPLY function is still disabled pending independent operator key enrollment and explicit authorization. No real STAGING entitlement has been changed.
