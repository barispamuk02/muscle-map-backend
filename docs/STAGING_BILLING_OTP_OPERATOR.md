# Local staging billing-email ownership challenge

Status: **one real owner-requested challenge sent, but verification was NOT completed; corrected local script now prepared for a separately authorized fresh attempt**. This workflow remains local-operator only, not accessible as a public HTTP route. Use only the dedicated staging Neon DB branch and the read-only Dodo LIVE audit key.

## Trust boundary

`scripts/dodo-staging-send-otp.mjs` performs only two **GET** calls to Dodo LIVE, then verifies that the Dodo billing email matches **exactly one verified, not banned Neon Auth account** on staging, that the Dodo customer ID matches **exactly one existing paid legacy account**, and that no conflicting claim or current paid identity exists. The resulting mailbox challenge is tied to issuer, subject and Dodo customer ID. The local launcher prompts for explicit `SEND` before initiating Dodo + Neon validation, and will send only after validation succeeds. The API credential stays on the operator's computer. The recipient comes only from the authenticated Dodo merchant read, never from browser data or clipboard-supplied arbitrary address.

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
4. On acceptance and successful merchant + staging checks, send a *fresh* 6-digit billing-ownership OTP via Resend to Dodo-provided billing email. Save only the HMAC digest and metadata in staging. The PowerShell launcher captures the `clm_...` identifier in memory and passes it directly to the confirmation command without displaying, saving or requiring its manual entry. Resend response means accepted mail, not confirmed ownership.
5. When the new mail arrives, type `YES` and enter only the NEW six-digit code via hidden PowerShell input **within the SAME launcher session**. The challenge identifier is automatically passed by the launcher; never manually copy or enter it. The original ephemeral HMAC secret stays in that session through confirmation; the script cleans all environment variables afterward. The database records a one-time successful verification only if all safeguards pass.
6. STOP. Do not automatically execute `linkLegacyPremiumAfterReview`. After a separately requested approval, build and run a privileged operator-only process to reread Dodo merchant records and the consumed staging challenge, then plan audited staging migration. Production migration and expiry reconciliation require separate approvals and release checks.

## Current status and limitations

- Owner manually confirmed that the Dodo billing email and Neon sign-in email match. This statement alone is NOT independent proof.
- Read-only staging Neon audit showed one verified unbanned Neon Auth user, one attached unentitled auth identity, one eligible historical paid row created October 14, and no migration claims.
- Local read-only merchant audit was successful with USD 3.99 and period through 2026-11-14T04:23:24.489Z, no refund/dispute indicated in payment details. The actual old Neon expiry still differs.
- Owner already ran the previous local operator version successfully through Resend mail delivery. Confirmation failed at local `LOCAL_STAGING_OTP_CONFIG_INVALID` before database OTP validation. Staging DB showed one sent challenge and no consumed/verified challenge; the ephemeral HMAC secret was erased at script exit, so that older code cannot be verified in a new session. Corrected source requires an explicit fresh `SEND` to issue a new code, which replaces the unusable one. No real legacy claim has been written.
- No Dodo LIVE key is ever deployed to publicly reachable staging Render.
