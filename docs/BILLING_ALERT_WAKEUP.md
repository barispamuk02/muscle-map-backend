# Billing risk alert wake-up: operational limits

GitHub Actions runs the `Wake billing risk alert worker` workflow every 10 minutes on the default branch (and via manual dispatch). It calls ONLY the public `GET /health` endpoint. It does not have secrets or call Dodo or database APIs.

The Render service's existing production startup invokes `startRiskAlertLoop()`, which attempts `flushPendingRiskAlerts()` immediately; the running process retries once per hour. Pending `payment_risk_events` rows stay in Neon until delivery is accepted and `alert_sent_at` is set. Signed Dodo refund/dispute webhook commits trigger immediate delivery attempts independently.

This wake strategy is best-effort only: GitHub scheduled workflows can be late or skipped; Render free instances may sleep; availability and response speed are not guaranteed. A successful HTTP /health does NOT prove mail delivery or an empty queue. Check workflow failures and the risk ledger regularly. If Dodo processing must have predictable delivery SLAs, move to an always-on worker or external managed scheduler and implement dedicated alert escalation. Do not create synthetic payments/refunds on Production.

Run the workflow manually in GitHub Actions to validate wake-up; confirm HTTP healthy. Do not report actual refunds/disputes as end-to-end tested by this health probe.
