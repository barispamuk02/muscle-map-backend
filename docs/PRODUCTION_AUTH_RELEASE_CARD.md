# Muscle Map — single Production Auth release card (2026-10-16)

## Provisioning completed — 2026-10-16

Owner explicitly approved Production Managed Better Auth provisioning and the sole trusted domain, **not** Production deployment, Premium migration or billing writes.

- Project: `sparkling-sun-97014945`; Production branch `br-odd-hat-b135xeiq`; database `neondb`.
- Provider: Managed Better Auth (distinct from STAGING).
- Real Production Auth base URL (public): `https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech/neondb/auth`.
- Exact `AUTH_ISSUER` and `PRODUCTION_AUTH_ISSUER`: `https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech`.
- Exact `AUTH_JWKS_URL` and `PRODUCTION_AUTH_JWKS_URL`: `https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech/neondb/auth/.well-known/jwks.json`.
- Trusted domain confirmed: `https://muscle-map.app`.
- **DO NOT PUBLISH YET**: New Neon Auth currently reports `require_email_verification: false`, `verify_email_on_sign_up: false`, `verify_email_on_sign_in: false`, and `allow_localhost: true`. The connector's available auth update action cannot modify these flags. In Neon Console, select **Production** branch -> **Settings -> Better Auth**; enable **Sign-up with Email**, **Verify at Sign-up**, select **OTP/code**, require email verification for sign-in, and disable production localhost allowance in domain settings. Verify these flags again via Neon Auth config before publishing. This is a necessary configuration fix, not an invitation to repeat unrelated STAGING checks.
- Production database baseline prior to enabling: 3 users, 3 future-dated Premium rows, 0 payment ledger rows, 2 webhook records, exactly 1 matching real Dodo customer. Enabling Auth does not authorize rewriting these rows.
- No Production Render deployment or env updates; no PR merge; no Dodo LIVE operations; no edits to the preserved Neon Production backup.

Frontend pre-release generation command (from Draft PR #11, after email verification is enabled):
```powershell
node scripts/prepare-production-account-config.cjs "https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech/neondb/auth"
```
This creates an **inactive** local `account-config.production.js`; do not replace `account-config.js` or deploy without a separate, complete cutover approval.


**Status: PREPARED, NOT AUTHORIZED TO ENABLE OR DEPLOY PRODUCTION.**
This is the actionable cutover card, not a request for more STAGING branches or repeated checks.

## Verified baseline (do not rewrite history)

- Neon project `sparkling-sun-97014945`, active database branch `production` (`br-odd-hat-b135xeiq`), Managed Neon Auth **disabled** on Production.
- Neon STAGING Auth (`br-jolly-sunset-b1pl23nn`) has separate issuer and key set. Its live browser login, logout, session restore, and the owner's paid Premium through **2026-11-14** passed. **Do not copy** STAGING issuer, users, JWKS, database URL, or credentials into Production.
- Render Production service `srv-db29eduk1f9s739kr6jg`, tracking Backend `main`; auto-deploy OFF. STAGING is `srv-db8ptljl550s73epdii0`.
- Existing backup branch `backup-production-pre-release-20261016` (`br-icy-lake-b17jxntb`) remains untouched; it is a same-project checkpoint, **not** an off-project immutable backup.
- Only **one real paying Dodo customer**. Merchant LIVE screenshot: later Oct 14 $3.99 charge Successful; earlier Oct 14 $3.99 charge Refunded; Oct 5 attempt requires customer action. The two extra legacy rows in Production are **not proven paying customers** and must not be auto-deleted or auto-claimed.
- Only one legacy account matches both merchant customer ID and signed checkout metadata. Its Production paid-through is 2026-11-13 but authenticated STAGING claim matches merchant confirmation through **2026-11-14**. Never revoke it because a *different, earlier* charge was refunded. Do not create another LIVE payment.

## Exact single-window action sequence, once explicitly authorized

**A. Authorize Production Neon Auth provisioning separately** (this creates an Auth integration and schema on the **Production** branch; not a no-op). Use Managed Better Auth on `br-odd-hat-b135xeiq`, `neondb`. Set application name `Muscle Map`, trusted domain `https://muscle-map.app`, disable any production localhost allowance where configurable, email/password with required verified email and OTP. Neon may expose independent `verify_email_on_sign_up`, `verify_email_on_sign_in`, and `require_email_verification` flags; a displayed `require_email_verification: true` **alone is not evidence of a delivered/consumed email OTP**. Use one genuine controlled mailbox and validate actual verified sign-in. Do not import Neon STAGING identities or keys. Record the new **Production** Auth base URL and JWKS URL from Neon, not a guessed hostname.

**B. Prepare reviewed configs, without leaking credentials.** Backend Production Render environment must use the actual Production Neon host and independent Production Auth:
```dotenv
APP_ENV=production
AUTH_PROVIDER=neon
REQUIRE_EMAIL_VERIFICATION=true
# Set only AFTER signed claim of the sole real paid owner:
PREMIUM_AUTH_REQUIRED=false
AUTH_ISSUER=<PRODUCTION_AUTH_BASE_URL_ORIGIN_ONLY>
AUTH_JWKS_URL=<PRODUCTION_JWKS_URL_FROM_NEON>
PRODUCTION_AUTH_ISSUER=<EXACT_SAME_PRODUCTION_AUTH_ISSUER>
PRODUCTION_AUTH_JWKS_URL=<EXACT_SAME_PRODUCTION_JWKS_URL>
PRODUCTION_DB_HOST=<ACTUAL_PRODUCTION_DB_HOST_ONLY>
DATABASE_URL=<EXISTING_PRODUCTION_CONNECTION_URL_WITH_SSLMODE_VERIFY-FULL>
ALLOWED_ORIGINS=https://muscle-map.app
DB_ALLOW_SELF_SIGNED=false
# Keep existing LIVE DODO_API_KEY and DODO_WEBHOOK_SECRET on Production ONLY.
# No STAGING_DB_HOSTS, STAGING_MAIL_TEST_ENABLED or localhost origins.
```
**Do not paste Render secrets into chat, GitHub, or logs.** Render connector does not support read-only secret environment listing. Confirm nonsecret names and matching hosts in the Render Dashboard locally. When final cutover is approved, change `PREMIUM_AUTH_REQUIRED` to `true` only after signed owner claim has succeeded. Existing `production-auth-rollout-guard.js` intentionally rejects unsafe cutover settings before opening the server.

Frontend: run `node scripts/prepare-production-account-config.cjs "<PRODUCTION_NEON_AUTH_BASE_URL>"` from Draft frontend PR #11; the generator rejects the known STAGING issuer, http, local and foreign domains. The generated `account-config.production.js` is **not active** until its contents are reviewed and placed in `account-config.js` on the coordinated release branch. Do **not** ship the STAGING `account-config.js` to `muscle-map.app`.

**C. One controlled release and explicit approval.** Verify signed production account ownership for the sole real purchaser using the existing fresh Dodo billing ownership protocol, then perform precisely one paid-account claim under an operator-approved transaction. Preserve merchant-confirmed paid-through (Nov 14) and old legacy access until verified sign-in succeeds. Review additive Production `initDb` DDL and uniqueness prechecks before backend deploy; it creates tables/indexes automatically. Make the Backend release first with `PREMIUM_AUTH_REQUIRED=false` to avoid lockout while legacy users still exist, then turn on verified-auth cutover and publish coordinated Frontend only after the paid claim, guarded config and one authentic browser 200 / 401 / 403 check. Keep auto-deploy OFF. Record deployed commit SHAs.

**Do not prematurely call this a secure paid-content paywall.** Existing static-client Premium limits and downloadable assets remain inspectable client-side; server-side enforcement of truly paid functionality must be implemented or the user-facing commercial claim accurately narrowed before broad paid launch.

## Rollback and stop conditions

- On login, paid-entitlement, provider or Dodo webhook failure: stop releasing and restore the prior **code/config**, without blindly restoring a historical database branch over newer LIVE payments.
- Retain signed claims, webhook processing records, refund evidence and reconciled billing periods. For any refund of an earlier payment, preserve a newer valid unrefunded paid period.
- Abort if Production Auth issuer/JWKS equal STAGING, production DB host differs from the pinned host, OTP proof is unverified, valid owner cannot access Premium, or merchant/Dodo webhook origin cannot be verified.
- Do not mark Issue #10 complete or merge either Draft PR before specific owner approval for the live change.

## Current explicit approval boundary

Preparation and Draft GitHub changes are authorized; **Provisioning Auth on Production, altering Production Neon schema/claims, merging a Draft PR, changing Render Production environment, deploying Production, and contacting Dodo LIVE to charge/refund are not authorized by this card.** Obtain separate owner approval identifying the exact live action.


## Saved Production Auth settings verified (2026-10-16)

After operator saved the Neon Console **Verify at Sign-up** (verification code) setting, independent Neon Auth config returned `email_password.require_email_verification=true`, `email_verification_method=otp`, and trusted origin `https://muscle-map.app`. Two separate fields, `verify_email_on_sign_up=false` and `verify_email_on_sign_in=false`, remained unchanged even though Console showed Verify at Sign-up enabled. **Do not interpret these two flags by themselves as proof of a failed sign-up policy, and do not claim email delivery has passed.** Verify a genuine new Production account requires/consumes an email OTP during the separately approved acceptance test. Production `allow_localhost=true` is still pending: Neon recommends turning it OFF before public launch. Connected Neon auth-config update exposes only application name, not the localhost or email/password switches, so the operator must change those via Neon Console. Other optional work (Google shared OAuth, custom SMTP, wider content-paywall enforcement) remains separate from enabling the provider.
