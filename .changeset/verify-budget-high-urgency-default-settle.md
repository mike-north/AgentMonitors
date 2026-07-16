---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
'agentmonitors': minor
---

Fix `agentmonitors verify` spuriously FAILing on the recommended default monitor configuration
(`file-fingerprint` + `urgency: high`, no `notify:` block) on its very first invocation.

`resolveSettleMs` (`apps/cli/src/verify-budget.ts`) returned `0` whenever a monitor declared no
`notify` block, but the runtime still applies a default 15s debounce settle to a `high`-urgency
observation with no explicit `notify` override before it materializes
(`defaultNotifyConfigForUrgency`, `service.ts`). For the recommended default's 30s
`file-fingerprint` interval, the auto-derived budget undershot real end-to-end delivery (~60s) by
exactly that omitted 15s, FAILing at ~53s even though the same monitor passes with a larger
`--timeout-ms`.

`resolveSettleMs` now delegates to `defaultNotifyConfigForUrgency` (newly exported from
`@agentmonitors/core`) instead of reading `monitor.frontmatter.notify` directly, so the budget can
never drift from the engine's own notify-default resolution. The default settle value is now the
named constant `schedulingDefaults.highUrgencyDefaultDebounceSettleMs` (15s) rather than a
hand-mirrored literal. An explicit `notify.settle-for` still overrides the default outright; a
non-high-urgency monitor with no `notify` still resolves `settleMs` to `0`.
