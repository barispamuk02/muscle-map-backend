# Dodo LIVE account ownership reconciliation

**Status:** internal draft implementation and automated tests. No account is linked and no Dodo LIVE API has been contacted by this implementation. This is not a public checkout or customer-claim endpoint.

## Independent trust boundaries

1. **Merchant-side facts** come only from authenticated read-only Dodo LIVE requests: `GET /payments/{payment_id}` and `GET /subscriptions/{subscription_id}`. The server checks status `succeeded` / `active`, matching customer/subscription IDs, Muscle Map Premium product, USD 399 cents, payment `service_periods[0].ends_at`, and subscription `next_billing_date`. It refuses refund/dispute cases, mixed subscriptions, mismatched dates, unknown products, and incomplete records.
2. **Authenticated identity** is a signed JWT from Neon Auth, with email verification read from the Neon Auth database. The verified account's email must match the billing email **retrieved directly from Dodo**.
3. **Independent possession** requires a *fresh, single-use* 6-digit challenge delivered through a trusted email sender to the Dodo billing address. The challenge is bound to the verified Neon issuer/subject and Dodo customer ID, expires in 10 minutes, allows at most 5 guesses and 3 challenge issuances/hour, and is stored in `billing_email_challenges` as a keyed HMAC digest, not plaintext.
4. Only an **internal authenticated reviewer** with merchant-side and DB challenge evidence may use the existing transactional `linkLegacyPremiumAfterReview` primitive. No `/claim` endpoint exists. Screenshots, browser-submitted Customer IDs, customer portal links and ordinary email matching are never adequate.
5. Repeat migration must be idempotent, audited, and must preserve the paid record and subscription. No new checkout, charge, refund, or Dodo subscription mutation.

## Implemented, not yet wired to an operational backend

- `dodo-ownership-audit.js`: read-only merchant GET helper and strict evidence validator.
- `billing-email-otp.js`: challenge issuance, redemption **and trusted readback from the consumed PostgreSQL row**, including fresh send callback and replay prevention.
- `trusted-dodo-claim-review.js`: internal-only composition of a server-read verified Neon account, consumed OTP from PostgreSQL and authenticated Dodo LIVE read; suitable as the strict callback for `linkLegacyPremiumAfterReview`, with no Express route.
- `legacy-account-claim.js`: rejects an unsupported customer-portal-only claim or a proof lacking the exact consumed OTP audit reference and Dodo paid-through timestamp.
- `db.js`: challenge table and index, applied by `initDb()` only when the Draft backend is intentionally deployed. No existing production schema was changed.
- `tests/dodo-ownership-audit.test.js`: Dodo fixture audit validation and malicious/missing evidence cases.
- `tests/billing-email-otp.integration.mjs`: disposable PostgreSQL 16 integration with **fake local email delivery**, fake Dodo GET responses, synthetic Neon users and an **actual transactional synthetic legacy claim** after trusted record readback. No real Dodo API calls, inbox codes, or user subscriptions are involved.
- Backend CI runs both test suites, independently of the existing signed JWT, payment ledger and webhook suites.

## Remaining integration gates

**Merchant credentials:** Dodo is not connected as a ChatGPT plugin. A separate authorized server-side Dodo LIVE audit credential must be configured securely in a privileged back-office process, ideally read-only/scoped if the platform supports that permission. It must NEVER be pasted into a chat, GitHub, CI logs, localStorage or `muscle-map-backend-staging` Render, which correctly forbids LIVE Dodo credentials. No actual payment fetching can occur until this is available.

**Email sender:** There is no trusted SMTP/API email sender wired to `sendEmail`. Configure one using approved credentials stored outside GitHub; use DKIM/SPF and abuse protection. Run a controlled real inbox trial for incorrect/expired/valid/replayed codes before handling actual claims. The Neon signup verification OTP is a different challenge, and **does not automatically prove a Dodo subscription claim**.

**Application orchestration:** The internal callback composition is coded but not deployed. A *privileged operator workflow* must still be built with authentication, permission gates, mail delivery, and production-safe approval controls. It must:
  - obtains an independently verified Neon JWT/subject, confirmed email, and a merchant-side Dodo customer/payment selection (do not accept payment ID as proof of ownership);
  - fetches authenticated Dodo LIVE payment/subscription, validates product and exact billing period;
  - calls issue challenge with recipient from Dodo, not the user;
  - reads the **stored consumed** challenge in a trusted context and runs reconciliation;
  - reviews the result, authorizes migration and reconciles original `premium_expires` with verified Dodo service period (do not shorten), with separate explicit consent.
No such operational service or live-admin challenge is deployed yet. Internal synthetic test success is **not** a real subscriber claim.

**Refunds and disputes:** Define validated refund/chargeback policy before production. This reconciler intentionally refuses any refund/dispute record instead of guessing entitlement rules.

**Security:** Public server remains staging-only with LIVE checkout/webhooks disabled. Frontend PR #11 and backend PR #2 remain Draft; Render Auto-Deploy remains OFF. Do not commit or share customer billing PII, API keys, code, or the user’s historical transaction IDs to public issues.

## Docs
- https://docs.dodopayments.com/api-reference/payments/get-payments-1
- https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions
- https://docs.dodopayments.com/developer-resources/webhooks/intents/payment

## Automated validation outcome

GitHub Actions backend Draft CI run `38853127990` passed all Node regression and disposable PostgreSQL integration checks, including an exact provider-paid period, no-payment/duplicate regressions, merchant GET-only requests, bad/expired/replayed OTP, per-hour throttling, and an audited **synthetic** Dodo claim. Isolated Auth HTTP E2E run `38853127985` also passed. Neither run had real Dodo credentials nor delivered email.


## 2026-10-16: Resend staging mail transport

- Domain `notify.muscle-map.app` verified in Resend; DNS DKIM and both outbound CNAMEs confirmed, incoming delivery remains at the existing separate provider.
- Resend API key named `muscle-map-staging-mail` stored under **Render staging** environment key `RESEND_API_KEY` (value never copied to GitHub, ChatGPT or logs). Key presence in Render UI is not proof that Resend has accepted a real message yet.
- `resend-mailer.js`: trusted server mail adapter uses `POST https://api.resend.com/emails`, fixed `Muscle Map Security <security@notify.muscle-map.app>` sender, separate one-time idempotency per claim code, no secret/recipient logging and no checkout/payments API access.
- `billing-email-otp.js`: passes server-generated `challengeId` to mail adapter; actual ownership challenge still requires a trusted operator-selected Dodo recipient and separate `OTP_HMAC_SECRET` before it may be deployed for real subscribers.
- `staging-mail-test.js`, `/api/staging/me/mail-test`: **staging-only**, gated by `STAGING_MAIL_TEST_ENABLED=true`, needs signed Neon JWT, reads email only from verified non-banned Neon Auth user, rejects an arbitrary request body, and sends a harmless "email transport test" no more than once per 24h per account. This does **not** verify Dodo ownership or change Premium.
- PostgreSQL stores the last staging-mail test timestamp, and the sender uses deterministic same-day Resend idempotency. Existing Live Dodo APIs remain inaccessible in staging.
- Backend mocked Resend + disposable PostgreSQL CI **passed**; frontend desktop/mobile/browser CI **passed**. Staging Render deploy `dep-db8rgn6q1p3s7394shrg` reported `live` with `DB initialized`. Manual delivery to a genuine mailbox is still pending.
- Release blocker: real Resend API send/delivery + anti-abuse verification, independently reconciled Dodo paid period, separate billing-email OTP proof, authenticated admin-only migration, refund/dispute cases and controlled rollout. No production deploy or historical account transfer.


## 2026-10-16: separate read-only Dodo LIVE key and local merchant audit

- The owner created a **new, narrowly restricted** Dodo LIVE key `muscle-map-billing-audit`: `Payments → Read` and `Subscriptions → Read`, 2 of 18 resources; no write, refund or checkout permissions. This is separate from the pre-existing live checkout key.
- This key is **NOT installed in Render staging**, nor is its secret committed to a repo or attached to a GitHub Action.
- `scripts/dodo-live-audit.mjs` is an **interactive local-only read tool**. It reads the key from temporary `DODO_AUDIT_API_KEY` in the operator's shell, prompts for exact payment ID and subscription ID without persisting either, makes only two authenticated Dodo LIVE GET requests via `retrieveDodoLiveBilling`, then prints a PII-free merchant summary. All user identifiers, email, card details, metadata, and raw responses stay in local process memory and are not printed or saved.
- `dodo-merchant-preview.js` performs fail-closed checks: successful USD 399 cents payment, active subscribed product, matching merchant customer IDs and billing emails, a single matching paid `service_periods`, Dodo next billing date, no recorded refunds or disputes. `product_cart` may be null on recurring subscription charges; authoritative product validation is via the retrieved subscription.
- Any missing/conflicting evidence stops audit with a category code and needs manual review. **A clean merchant result is not evidence that any particular Neon Auth login owns the subscription**.
- Do not print or share `DODO_AUDIT_API_KEY` or raw JSON. Share only sanitized console output beginning with `DODO_LIVE_MERCHANT_AUDIT_RESULT`; never share full payment/customer/subscription IDs or address.

### Secure Windows PowerShell operator procedure (once CI green)

In a separate clean local checkout of the backend Draft branch, never inside the web frontend, launch:

```powershell
$secure = Read-Host "Dodo LIVE audit key (hidden input)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:DODO_AUDIT_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    node .\scripts\dodo-live-audit.mjs
} finally {
    Remove-Item Env:\DODO_AUDIT_API_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

Do not capture terminal output containing prompted IDs; copy only the sanitized result lines. This process does not perform billing mutations, Neon database queries or any user account migration. If Dodo responds with an unexpected schema or a permission error, stop and inspect documentation rather than requesting write access or using the checkout API key.

**Release blockers remain:** independent billing-inbox one-time challenge, verified Neon login, explicit audited claim approval, refund/dispute policy, staging rehearsal with actual authorized owner and production rollback gates. Real account claim has not occurred.
