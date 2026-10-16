# Local staging billing-email ownership challenge

Status: **code prepared, no real claim sent or verified**. This workflow remains local-operator only, not accessible as a public HTTP route. Use only the dedicated staging Neon DB branch and the read-only Dodo LIVE audit key.

## Trust boundary

`scripts/dodo-staging-send-otp.mjs` performs only two **GET** calls to Dodo LIVE, then verifies that the Dodo billing email matches **exactly one verified, not banned Neon Auth account** on staging, that the Dodo customer ID matches **exactly one existing paid legacy account**, and that no conflicting claim or current paid identity exists. The resulting mailbox challenge is tied to issuer, subject and Dodo customer ID and requires typed `SEND` consent in the local terminal. The API credential stays on the operator's computer. The recipient comes only from the authenticated Dodo merchant read, never from browser data or clipboard-supplied arbitrary address.

`scripts/dodo-staging-confirm-otp.mjs` confirms the fresh code once in the staging DB. It does NOT link users, modify Premium, change Dodo billing, access production or even contact Dodo. It only marks a challenge as consumed (10-minute expiry, max 5 attempts).

## Required protected local operator configuration

Run in a clean Windows PowerShell from the isolated backend Draft checkout:

- `DODO_AUDIT_API_KEY`: separate Payments Read and Subscriptions Read LIVE key, entered silently and cleared after use.
- `DATABASE_URL`: **staging** Neon branch only. The local sending and confirmation scripts block every database host except the dedicated `ep-summer-recipe-b1qi9f29` direct and pooled hosts.
- `RESEND_API_KEY`: already domain-restricted send-only key for `notify.muscle-map.app`; needed **only for issuing** the OTP locally.
- `OTP_HMAC_SECRET`: separately generated cryptographically random value, at least 32 characters, kept exclusively on the operator's own computer. The *same* value must remain accessible until verification finishes; do not store it in a repository or issue.
- `AUTH_ISSUER`: the exact staging Neon Auth issuer, equal to `https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech`.
- `APP_ENV=staging`.

To prevent accidental secret disclosure, load secret variables using `Read-Host -AsSecureString` rather than embedding values in shell commands, terminal history, JSON or screenshots. Do not save these in `.env`, localStorage or GitHub Actions. Confirm the staging DB hostname before loading credentials. Do not send raw terminal output, SMTP codes, full customer/payment/subscription IDs or the challenge ID to chat.

## Operator flow, do not execute without explicit authorization

1. Upgrade the **separate local working copy** from the Draft branch using `git pull --ff-only` and check that CI passed.
2. Read live merchant payment+subscription in the local process, retrieve exactly one matching staging old Premium and exactly one confirmed Neon account with matching billing address.
3. Prompt for explicit `SEND`; without this exact answer no email is sent and no challenge row is created.
4. On acceptance, send a *separate* 6-digit billing-ownership OTP via Resend to Dodo-provided billing email. Save only HMAC digest and metadata in the staging DB. In terminal show the `clm_...` challenge identifier locally and 10-minute expiry. Resend response represents accepted mail, not confirmed mailbox ownership.
5. After owner receives the mail, enter the challenge ID and six-digit code **only in local PowerShell hidden input environment variables**, then run `node scripts/dodo-staging-confirm-otp.mjs`. The secret and OTP are not logged or sent to ChatGPT. The database records one-time successful verification.
6. STOP. Do not automatically execute `linkLegacyPremiumAfterReview`. After a separately requested approval, build and run a privileged operator-only process to reread Dodo merchant records and the consumed staging challenge, then plan audited staging migration. Production migration and expiry reconciliation require separate approvals and release checks.

## Current status and limitations

- Owner manually confirmed that the Dodo billing email and Neon sign-in email match. This statement alone is NOT independent proof.
- Read-only staging Neon audit showed one verified unbanned Neon Auth user, one attached unentitled auth identity, one eligible historical paid row created October 14, and no migration claims.
- Local read-only merchant audit was successful with USD 3.99 and period through 2026-11-14T04:23:24.489Z, no refund/dispute indicated in payment details. The actual old Neon expiry still differs.
- Scripts and tests are committed only in Draft backend branch; they have not contacted LIVE Dodo, delivered a claim code or written a real claim in this iteration.
- No Dodo LIVE key is ever deployed to publicly reachable staging Render.
