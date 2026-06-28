---
'@agentmonitors/cli': patch
---

Fix: `hook deliver` emits a reminder line for pending `normal`/`low` changes (Refs #198)

A default file-fingerprint monitor (`urgency: normal`) was silent mid-session. The wired
`agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
`normal`-urgency change because `renderHookDelivery` returned `null` whenever the claim carried no
event bodies (`events: []`), even though the claim had a populated advisory `message`. `hook claim`
reported the reminder while `hook deliver` — the actually-wired command — did not.

`renderHookDelivery` now renders the claim's advisory `message` (sanitized and length-capped) into
`hookSpecificOutput.additionalContext` for a `normal`/`low` reminder claim, producing a visible
mid-turn reminder line (no per-event body block). The claimed rows are still **not** acknowledged
(BP2 / SP4), so the event stays unread and re-discoverable via `agentmonitors events list --unread`.

High-urgency body injection and the `post-compact` (`SessionStart`) recap are byte-unchanged.
`hook deliver` still prints nothing and exits 0 when there is genuinely nothing pending.
