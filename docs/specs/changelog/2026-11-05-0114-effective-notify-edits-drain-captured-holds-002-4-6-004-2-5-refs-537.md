## 2026-11-05 — Effective notify edits drain captured holds (002 §4.6, 004 §2.5) — Refs #537

Record decision #556: a changed effective notify policy flushes accepted old work before new
source observation, even before a debounce deadline or rollup window. Preserve captured semantics;
unchanged pacing and body-only edits keep normal clocks. The whole edit drain rereads under an
owned writer transaction and commits materialization with hold removal; failure retains all state
and backpressures only that monitor. Specify restart, missing-definition diagnostics, independent
writer exclusion, real SQLite faults and actual bounded-child kill acceptance. Ordinary flush
recovery remains separate.

