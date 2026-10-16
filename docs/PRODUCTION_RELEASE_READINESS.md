# Muscle Map Issue #10 — Production release-readiness audit

Last read-only inspection: 2026-10-16. **NOT APPROVED FOR PRODUCTION DEPLOYMENT**. This audit and code are on backend Draft PR #2 and frontend Draft PR #11. The owner's confirmation authorizes **preparation**, not a live production migration, charging a customer, enabling Neon Auth in production, merging, or switching old Premium clients off.

## Independently verified environments

| Gate | Isolated Neon STAGING | Neon production |
|---|---|---|
| Branch | `br-jolly-sunset-b1pl23nn` | `br-odd-hat-b135xeiq` |
| Managed Neon Auth | Enabled with email-verification requirement | **NOT enabled** |
| `neon_auth.user` | Exists | Absent |
| `public.auth_identities` | Exists | Absent |
| `public.legacy_account_claims` | Exists | Absent |
| `public.billing_email_challenges` | Exists | Absent |
| `public.payments` | Exists | Exists |
| Verified real paid legacy-to-Neon claim | **1**, signed, matching source account and customer | **Not performed** |
| Existing active Premium rows | 3 before isolated claim | **3** |
| Active Premium rows with historical Dodo customer mapping | 2 before claim | **2 of 3** |
| Historical webhook event rows | Separate staging data | **2** |
| Historical payment ledger rows | Separate staging data | **0** |

The one completed STAGING claim was independently verified as signed with an Ed25519 operator approval, matching the legacy paid customer and verified Neon identity, with an atomic paid-through correction from `2026-11-13T04:23:25.043Z` to merchant-confirmed `2026-11-14T04:23:24.489Z`. No rollback occurred. This is not evidence that the other paid subscribers have been migrated to production or staging.

The managed STAGING tenant currently reports `require_email_verification: true`, `email_verification_method: otp`, but `verify_email_on_sign_up: false` and `verify_email_on_sign_in: false`; these are separate settings. Complete actual inbox signup, bad/expired OTP, verification, session refresh and cross-device acceptance tests before trusting the account experience. Dodo billing-email proof is a **separate** fresh email challenge from Neon Auth signup verification.

## Mandatory blockers before any production deploy or merge

1. **Production Auth provider and verified-email UX**: Provision separately owned production Neon Auth, preserving STAGING. Validate exact issuer, JWKS, email verification config, trusted origins, real delivered/consumed OTP, and logout/refresh. Do not import STAGING Auth users or keys into production.
2. **Real legacy subscriber ownership**: 3 active historical Premium users remain in production. Only 2 have a Dodo customer mapping; 1 cannot be inferred from email or localStorage ID. Independently reconcile all historical paid customers, preserve paid-through and conflicts, and obtain fresh verified account proof before linking each user. Never "repair" the database by granting a guessed subscription.
3. **Historical payment ledger**: 2 production webhook events but 0 payment rows. Reconcile them through independently authenticated Dodo records before interpreting historical records. Do not fabricate or replay live charges.
4. **Refund/dispute/chargeback handling**: Verify merchant webhook semantics and transaction ordering for successful payment, renewal, expiry, refund, dispute, cancellation and ambiguous periods. A missing paid period must fail safely, and refund/reversal policy must be explicit. This is not fully implemented.
5. **Premium server enforcement**: Static premium-only functions and downloadable assets remain client-readable even if the new API hides a button. Move truly paid functionality behind authenticated server checks, or explicitly describe it as an unprotected convenience UI. Do not market it as secure Premium access before fixing.
6. **Deployment/restore strategy**: Choose the actual Render workspace/service, read production environment configuration without disclosing secret values, confirm auto-deploy remains OFF, take an independently verified backup/restore point, and rehearse rollback against an isolated clone. Concurrent new Dodo payments make full database restoration unsafe without reconciliation.
7. **Browser integration**: Test full real frontend/backend wiring against a dedicated STAGING instance using logged-in JWT and original subscriber after F5, logout/login, a second device, mobile and desktop. Do not set the frontend to production issuer before standalone production Auth is provisioned and tested.
8. **Production-only configuration gate**: New `production-auth-rollout-guard.js` prevents startup when `APP_ENV=production` and `PREMIUM_AUTH_REQUIRED=true` unless the production Neon Auth issuer, JWKS and DB host are explicitly pinned, email verification required, TLS uncompromised, LIVE Dodo secrets present, correct origin allowed and STAGING identifiers excluded. This guard does **not** prove customer migration and is not permission to enable authenticated-only mode.

## Two independently approved release stages

**Stage A — backward-compatible billing/account code release (separate approval required):**
- Leave `PREMIUM_AUTH_REQUIRED=false`; old IDs and existing active Premium access continue to work.
- Audit and approve new Dodo payment/webhook semantics using real sanitized samples, including refunds, disputes and renewals. A changed handler can affect **live** subscription payments even when Auth cutover is disabled.
- Before any production schema initialization, take backup and compare additive DDL against production. Never point operator or test scripts at production.
- Keep GitHub PRs in Draft, Render Auto-Deploy OFF, run full CI, smoke-test isolated staging.
- Roll back only code when feasible; never blindly restore a database snapshot that would erase new paid transactions.

**Stage B — verified auth cutover (separate approval required):**
- Provision production Neon Auth independently, with required email verification, origin controls and real inbox acceptance checks.
- Configure new production-only pins `PRODUCTION_AUTH_ISSUER`, `PRODUCTION_AUTH_JWKS_URL`, `PRODUCTION_DB_HOST`, plus existing `AUTH_ISSUER`, `AUTH_JWKS_URL`, `DATABASE_URL`, and correct `ALLOWED_ORIGINS`.
- Link each historical Premium only after independently verified Dodo ownership; resolve or explicitly preserve the record lacking a customer identifier.
- Test both legacy+new flows, active/cancelled/expired users, correct status and entitlement continuity. Only then approve `APP_ENV=production`, `AUTH_PROVIDER=neon`, `REQUIRE_EMAIL_VERIFICATION=true`, `PREMIUM_AUTH_REQUIRED=true`, in a maintenance window.
- Monitor 401/403/5xx on premium/status, Dodo webhook retries, paid-through and duplicate ledger writes after rollout. Re-enable legacy only using a reviewed rollback plan, respecting latest payment changes.

## Production Auth cutover guard (draft-only)

The new guard executes before `initDb()` only when the deployment explicitly opts into production authenticated-only cutover. It rejects:
- Any STAGING issuer or STAGING database hostname.
- Unpinned production issuer, JWKS or database host, or a mismatched issuer / JWKS host.
- Invalid HTTPS Neon JWKS configuration.
- Missing verified email enforcement, missing Dodo LIVE credentials or disabled certificate verification.
- STAGING mail-test and database override configuration, missing `https://muscle-map.app` allowed origin, localhost-origin contamination.

No production credentials or customers belong in GitHub Actions test fixtures, the document, chat, or issue comments. Unit tests use only synthetic hosts and fake credentials; CI's PostgreSQL is disposable and independent of real Neon.

## Status

**READY**: one independent STAGING paid claim, signer audit, atomic period correction, staging schema, underlying backend and frontend Draft suites.

**NOT READY**: provisioning production Auth, genuine provider email lifecycle check, remaining customer ownership, LIVE Dodo ledger reconciliation, refund state machine, protected server-only paid operations, selected Render workspace and backup-based rollback.

**Current decision**: Do not merge, deploy, enable production Auth, toggle `PREMIUM_AUTH_REQUIRED`, touch production payment rows or issue any LIVE charge. Continue evidence-based code and verification work in Draft PRs.
