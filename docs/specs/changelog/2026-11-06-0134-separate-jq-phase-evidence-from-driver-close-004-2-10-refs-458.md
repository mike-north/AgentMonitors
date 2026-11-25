## 2026-11-06 — Separate jq phase evidence from driver close (004 §2.10) — Refs #458

The negative driver accepts the complete Vitest end-of-run report for the exact intended
module/test plus one terminal owned jq command within the existing 4-second phase bound.
It does not substitute a first error message or natural reporter/process close for whole
phase evidence. A separate hard 1-second driver close/group-confirmation reservation
fits inside the unchanged 6-second test. A signal error is not termination evidence;
cleanup still requires independent terminal/close confirmation and retains signal failure
when that confirmation fails. The jq 1,000ms budget, one-filter selection, both positive
canonical controls and production helpers remain unchanged.

