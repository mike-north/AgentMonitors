## 2026-11-25 — Doctor delivery checks agree with available routes (005 §15) — Refs #462

Unmatched channel sessions are advisory and cannot establish delivery to an active session.
Channel coverage gaps are advisory when matching fresh hook evidence covers those sessions.
Doctor preserves all problem details while keeping transport checks non-failing whenever delivery
is available. Unrelated failing checks still cause exit 1. Transport unit tests and built-CLI
scenarios verify health, text/JSON diagnostics, exit status, and the delivery-check invariant.
The corresponding doctor gap is removed from roadmap G22.

