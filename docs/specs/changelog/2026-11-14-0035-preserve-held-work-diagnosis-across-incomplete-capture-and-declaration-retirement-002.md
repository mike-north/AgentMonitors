## 2026-11-14 — Preserve held-work diagnosis across incomplete capture and declaration retirement (002 §10.7; 005 §6, §15) — Refs #574

Incomplete captured rollup metadata yields unknown timing without hiding accepted
counts or aborting explain/doctor. Global ephemeral declarations share tick's
active workspace eligibility. Retired declarations retain visible batches with
lifecycle guidance: no future tick releases them and no definition file can be
edited. `blockedByDefinition` remains about definition repair, so is false for
retirement. Release and retention policy are unchanged. The additive public
`HeldNotifyWork` and doctor field ship in a core minor Changeset; CLI stays patch.

