---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

Add a first-class `agentmonitors verify [monitor]` command that proves a monitor delivers
end-to-end in one shot, replacing the fragile manual "prove it, right now" recipe (a custom
`--socket`, a scratch `AGENTMONITORS_DB`, a backgrounded daemon with `trap` cleanup, hand-built hook
JSON payloads, two poll loops, and two session-id concepts).

`verify` boots and supervises an **isolated** daemon (temp socket + db, reaping disabled), registers
a throwaway lead session, triggers a **real** change (an auto scratch-file for file-fingerprint
pattern globs, a restored-on-exit edit for a literal glob, or `--manual` watch mode for sources it
can't fabricate a change for), then polls with a budget **derived from the monitor's own interval +
notify settle (+ the 15s high-urgency claim-settle) + margin** — not a fixed 40s — printing
elapsed/ETA progress to stderr. Those interval/settle defaults come from the runtime's canonical
`schedulingDefaults` export in `@agentmonitors/core`, so the budget can't drift from what the daemon
actually schedules. It interprets the observation pipeline in plain language: a `triggered` outcome
is success and a `no-files-matched` outcome fails fast, while a `no-change` outcome fails fast **only
when the change isn't merely settling** — a `debounce`/`throttle` monitor holds the observed change
(recorded as a `suppressed` row) and emits `triggered` at flush, so a `suppressed` row keeps the wait
alive rather than being reported as its own outcome. A **dead daemon** fails fast with the daemon's
own error instead of an ambiguous empty result. It confirms delivery through the real `hook deliver`
claim path and prints one clean **PASS** (echoing the delivered `additionalContext`) or **FAIL**
naming the failing stage. Non-zero exit only on a genuine failure. Everything it created is cleaned
up on exit; `--use-workspace-daemon` instead targets and leaves running the real workspace daemon so
a follow-up `agentmonitors doctor` reflects the delivery. `--format json` emits a stable machine
shape; `--timeout-ms <ms>` overrides the detection budget.
