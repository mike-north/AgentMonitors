## 2026-06-29 — `api-poll` follow-ups: warning URL redaction and validation docs (003 §4.2, §4.7; 004 §3.2; 005 §2) — Refs #240

Resolved follow-ups from the `api-poll` change-detection cluster.

- **Warning redaction.** The explicit `json-diff` / non-JSON warning now strips URL username,
  password, query, and fragment before diagnostic text is returned, so embedded credentials or
  request tokens are not echoed in `monitor test` output or logs.

- **Scaffold decision.** `agentmonitors init --type api-poll` intentionally omits
  `change-detection.strategy`; the source infers `json-diff` for JSON `Content-Type`s and `text-diff`
  otherwise. 005 now reflects that current template.

- **Spec drift and validation matrix.** 003 §4.7 now matches §4.8: body-diffing strategies reject
  non-2xx responses instead of baselining them. 004 §3.2 now includes required rows for non-2xx
  errored behavior and explicit `json-diff` / non-JSON warnings.

