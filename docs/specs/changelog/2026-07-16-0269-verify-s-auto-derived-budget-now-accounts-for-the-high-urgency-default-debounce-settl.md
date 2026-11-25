## 2026-07-16 — `verify`'s auto-derived budget now accounts for the high-urgency default debounce settle (002 §9, 005 §16) — Refs #399, #406

`agentmonitors verify`'s auto-derived budget (`apps/cli/src/verify-budget.ts`, introduced for #399)
spuriously FAILed on the **recommended default monitor configuration** —
`file-fingerprint` + `urgency: high` with no explicit `notify:` block — on the very first
invocation. `resolveSettleMs` returned `0` whenever a monitor had no `notify` block, but the
runtime (`defaultNotifyConfigForUrgency`, `service.ts`) still applies a default 15s debounce
settle to a `high`-urgency observation with no explicit `notify` override before it
materializes (002 §9 / CLAUDE.md invariant: "`high` defaults to a 15s debounce settle"). For
the recommended default's 30s `file-fingerprint` interval, the computed `detectMs` undershot
real end-to-end delivery (~60s) by exactly the omitted 15s term (~53s vs ~60s), FAILing a
config that actually works.

Fixed by having `resolveSettleMs` delegate to `defaultNotifyConfigForUrgency` (now exported
publicly from `@agentmonitors/core`) instead of reading `monitor.frontmatter.notify` directly
— the same function the runtime tick uses to resolve the effective notify config, so the
budget can no longer drift from the engine's actual default. The default settle value itself
is now a named constant, `schedulingDefaults.highUrgencyDefaultDebounceSettleMs` (15s),
distinct from `highUrgencyClaimSettleMs` (both currently 15s, but independent knobs: one
delays materialization, the other delays hook-surfacing after materialization). An explicit
`notify.settle-for` still overrides the default outright; non-high urgency with no `notify`
still resolves `settleMs` to `0`.

