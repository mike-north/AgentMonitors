## 2026-06-11 — Follow-up: §10 session-id-equality question marked resolved (006 §10)

Review follow-up to the entry below (the PR merged before the review comment was addressed): the
2.1.160 re-verification already answered the **next** §10 open question — "confirm
`CLAUDE_CODE_SESSION_ID` equals the `hostSessionId` the `SessionStart` hook passes to
`session open`". The env var equals the live session id (verified), and the hook passes the stdin
`session_id`, which is by the hooks contract that same live id — so both transports resolve the same
identifier. The bullet is now marked **Resolved (2.1.160)** with the same observed-not-contracted
caveat. Docs-only; no changeset.

