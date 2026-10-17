# Premium progression release: owner approval required

Status: Frontend PR #14 and Backend PR #5 are DRAFT. No Production writes performed.
Both repositories are public. Do NOT commit private paid content there.
New private RU/EN JSON bundle prepared outside GitHub:
SHA256 645e12bea266b7e42a9475a49bb633984d392a14c965addbd76c48bb3de02646
Six programs x two languages x four phases. Previously publicly committed draft text must never be reused.

Pre-release verification (passed in CI):
- Signed JWT and verified email required; guest 401; Free 403; paid 200; expired/banned 403.
- SQL placeholders and private JSONB storage; no content in frontend or PWA bundle.
- Chrome production-host candidate: desktop/mobile Free denial and Premium fixture render.
- Existing Dodo and payment ledger regression checks.

Only after separate owner approval:
1. Deploy Backend PR #5 after CI, confirm healthy and no payment regression.
2. Insert six private bilingual content rows into premium_program_content directly in Neon Production using parameterized SQL (never public GitHub).
3. Verify row count and server-only 401/403/200; never create charges.
4. Deploy Frontend PR #14, verify Free/basic plans, Premium view, mobile/desktop, current paid entitlement.
5. Read back Neon payment and owner counts; do not touch legacy subscriptions or old claims.

Rollback: restore known good Frontend a241ccb6 and Backend b6293a34 if needed.
Retain additive data table; never overwrite new paid Production records with old backup.
