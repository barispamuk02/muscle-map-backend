# Premium account claim: controlled rollback plan (Draft PR #2 only)

Status: **implementation and automated synthetic testing only.** This is not approval to migrate or roll back any actual customer, including isolated Neon STAGING. The operator must obtain separate explicit permission for each real account linkage or reversal.

## What is captured when a claim is executed

Inside the existing transaction of linkLegacyPremiumAfterReview, the legacy_account_claims record now also stores:

- previous_user_id: the independently initialized, unentitled internal user ID to which the authenticated Neon issuer/subject was mapped BEFORE the paid-legacy link;
- premium_expires_at_claim: exact pre-link expiration stored for the historical paid user.

The old paid user's Dodo customer ID and expiry are never rewritten by the claim. These columns are added with non-destructive ALTER TABLE ADD COLUMN IF NOT EXISTS statements. For claims created before the addition, missing snapshot fields require manual recovery, not guessed user IDs.

## Operator-only reversal

reverseLegacyPremiumClaimAfterReview in legacy-account-claim-rollback.js is private code, NOT mounted as a route and intentionally has no operator CLI/deployment.

It requires a separately authenticated privileged operator's authorizeRollback callback, exact issuer/subject and original dodo-audit:clm_... evidence reference, a reviewer and a meaningful reason. Production authorization cannot come from the browser, a self-reported email, or a synthetic CI flag.

The reversal transaction locks the original claim and identity, then checks:

1. Original claim matches exact issuer, subject and evidence reference, with both preimage snapshots present.
2. Claim occurred within 24 hours; otherwise manual reconciliation is required.
3. No previous reversal exists.
4. Paid account retains the exact original customer ID AND expiration from the claim snapshot.
5. The issuer/subject still maps to this paid user; the original placeholder exists, has no Premium or Dodo customer ID, has no payments and is not used by another auth identity.
6. No payments have been recorded on the paid legacy user since the claim.

In one transaction the code creates one immutable row in legacy_account_claim_reversals and restores only auth_identities.user_id to previous_user_id. On any failure both actions roll back. The original claim audit, payment records and old paid user are retained. Reclaiming the same paid user remains blocked until a separately audited recovery policy is established.

## Important limitations and production blockers

- An injected authorization callback alone is NOT a full production-grade authorization system. A real signed or logged operator review mechanism must be independently implemented and tested before deployment. The synthetic CI callback is a fixture only.
- This is a narrow immediate recovery safeguard, NOT a refund, cancellation, general account transfer or cross-customer recovery tool.
- Production release requires independent Dodo recheck, a fresh billing OTP (historical consumed proof is stale for new linking), verified Neon account, explicit approval, operator logging, and verified backup/restore.
- Staging legacy expiry is different from merchant Dodo paid-through 2026-11-14T04:23:24.489Z. This requires a separate reconciliation; rollback refuses altered expiry after the claim.
- No actual staging account claim, reversal, billing mutation, production deployment or change to Render Auto-Deploy is authorized by this work.

## Synthetic tests

GitHub Actions Backend Payment Ledger Regression now runs tests/legacy-claim-rollback.integration.mjs on disposable PostgreSQL 16 (muscle_map_ci ONLY). Coverage includes:

- forward claim snapshot and preserved expiry / historical charge;
- missing operator approval, mismatched owner/evidence and invalid reason;
- 24-hour guard and missing snapshots;
- changed premium expiration, new old-account payment and placeholder payment;
- injected failure after audit insert demonstrating transaction rollback of BOTH audit and identity mapping;
- successful reversal to prior placeholder, immutable claim/reversal audits, blocked duplicate reversal and silent re-claim.

Never point this test or an operator script at Neon staging or production.
