## 2026-11-03 — Align the local pre-push gate with portable CI validation (004 §2.10) — Refs #458

Define `pnpm verify` as the sequential aggregate of CI's portable checks, including the
serial daemon suite, standalone consumer, fresh-install hook E2E, and publish dry-run.
Keep the fast `pnpm test` workload and print its omissions. A guard compares the actual
workflow and root scripts, requiring explicit decisions for new CI jobs or commands.
Document setup, platform, Docker availability, and website exceptions; website exclusion
is unchanged and expanding it remains a human decision.

