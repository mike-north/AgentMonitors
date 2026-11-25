## 2026-06-28 — `hook deliver` emits a reminder line for pending `normal`/`low` changes (006 §5.4, 005 §12.2) — Refs #198

Resolves a contradiction between the spec and the implementation. The spec already said a
`turn-interruptible` `normal`-urgency claim returns `events: []` with **"reminder text only"**, but
`renderHookDelivery` short-circuited to `null` whenever `events.length === 0`, so the wired
`agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
`normal`-urgency change. A default file-fingerprint monitor was therefore silent mid-session —
`hook claim` reported the reminder while `hook deliver` did not.

- **006 §5.4 — clarified.** "Reminder text only" is explicitly **not** silence: `hook deliver`
  renders the claim's advisory `message` (sanitized and length-capped) into
  `hookSpecificOutput.additionalContext` for a
  `normal`/`low` claim (`events: []`), producing a visible mid-turn reminder with no per-event body
  block. Body injection stays reserved for high-urgency settled events and the post-compact recap.
  `renderHookDelivery` returns `null` only for a `null` claim or one carrying neither events nor a
  reminder message.
- **005 §12.2 — clarified.** Step 7 and the closing note now state the reminder-line behavior
  precisely, with a reminder-only wire-output example. The claimed rows are **not** acknowledged
  (BP2 / SP4), so the event stays unread and re-discoverable via `events list --unread`.

High-urgency body injection and the post-compact recap are byte-unchanged. Affects published-package
behavior (`@agentmonitors/cli`), so a changeset accompanies this change. Refs #198.

