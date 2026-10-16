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
- `billing-email-otp.js`: challenge issuance and redemption against PostgreSQL, including fresh send callback and replay prevention.
- `db.js`: challenge table and index, applied by `initDb()` only when the Draft backend is intentionally deployed. No existing production schema was changed.
- `tests/dodo-ownership-audit.test.js`: Dodo fixture audit validation and malicious/missing evidence cases.
- `tests/billing-email-otp.integration.mjs`: disposable PostgreSQL 16 integration with a **fake local email delivery callback**, fake Dodo GET responses and synthetic emails. No real Dodo API calls, inbox codes, or user subscriptions are involved.
- Backend CI runs both test suites, independently of the existing signed JWT, payment ledger and webhook suites.

## Remaining integration gates

**Merchant credentials:** Dodo is not connected as a ChatGPT plugin. A separate authorized server-side Dodo LIVE audit credential must be configured securely in a privileged back-office process, ideally read-only/scoped if the platform supports that permission. It must NEVER be pasted into a chat, GitHub, CI logs, localStorage or `muscle-map-backend-staging` Render, which correctly forbids LIVE Dodo credentials. No actual payment fetching can occur until this is available.

**Email sender:** There is no trusted SMTP/API email sender wired to `sendEmail`. Configure one using approved credentials stored outside GitHub; use DKIM/SPF and abuse protection. Run a controlled real inbox trial for incorrect/expired/valid/replayed codes before handling actual claims. The Neon signup verification OTP is a different challenge, and **does not automatically prove a Dodo subscription claim**.

**Application orchestration:** Provide a *privileged internal operator service* which:
  - obtains an independently verified Neon JWT/subject, confirmed email, and a merchant-side Dodo customer/payment selection (do not accept payment ID as proof of ownership);
  - fetches authenticated Dodo LIVE payment/subscription, validates product and exact billing period;
  - calls issue challenge with recipient from Dodo, not the user;
  - reads the **stored consumed** challenge in a trusted transactional context and runs reconciliation;
  - reviews the result, authorizes migration and reconciles original `premium_expires` with verified Dodo service period (do not shorten), with separate explicit consent.
No such operational service or live-admin challenge is deployed yet.

**Refunds and disputes:** Define validated refund/chargeback policy before production. This reconciler intentionally refuses any refund/dispute record instead of guessing entitlement rules.

**Security:** Public server remains staging-only with LIVE checkout/webhooks disabled. Frontend PR #11 and backend PR #2 remain Draft; Render Auto-Deploy remains OFF. Do not commit or share customer billing PII, API keys, code, or the user’s historical transaction IDs to public issues.

## Docs
- https://docs.dodopayments.com/api-reference/payments/get-payments-1
- https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions
- https://docs.dodopayments.com/developer-resources/webhooks/intents/payment
