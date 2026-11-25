## 2026-11-14 — Classify held-work release prerequisites in tick order (002 §10.7; 005 §6, §15) — Refs #574

Add public `HeldNotifyBarrier` and `HeldNotifyWork.releaseBarrier`, preserving
`blockedByDefinition` as a persistent-definition diagnostic. Both commands share
read-only tick predicates for dormancy (including recent declarations), active
owners/declarations, source availability, definition validation, retries and
captured envelopes. Notify reconciliation and diagnosis share a read-only edit
plan, so an effective pacing change that drains before scheduling remains eligible. Stale or durably dormant owners no longer receive flush
promises or file-repair advice; unavailable sources ask for registration
restoration. Retention, dormancy and release policy remain unchanged. Core stays
minor for the additive public API; CLI stays patch.

