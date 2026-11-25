## 2026-11-06 — Avoid payload writes for no-input jq probes (004 §2.10) — Refs #458

A no-input version probe closes unused stdin without writing an empty payload that
can race jq's valid early exit. Explicit reduction input, including an empty string,
still requires delivery and rejects stdin errors. This resolves the Linux CI discovery
EPIPE failure without suppressing filter transport failures, retrying or increasing
any command/outer deadline. The canonical jq programs and source boundary are unchanged.

