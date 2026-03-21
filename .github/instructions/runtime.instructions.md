---
applyTo: 'libs/core/src/runtime/**/*.ts,libs/core/src/adapter/**/*.ts,libs/core/src/inbox/**/*.ts'
---

# Runtime And Adapter Review Guidance

- Treat the shared event log as the source of truth and session-scoped inbox or
  delivery records as projections.
- Preserve durable session semantics across daemon restarts and machine reboots.
- Do not accidentally share baselines, unread state, or acknowledgment state
  between sessions.
- Core runtime code should remain host-agnostic. Claude-specific lifecycle
  names or UI assumptions belong in adapters, not runtime services or storage.
- Keep urgency separate from recap or message-shaping concerns. Urgency is about
  delivery policy, not about summary format.
- High urgency delivery must not lose events during debounce windows.
- Normal and low urgency notifications should coalesce until the unread set is
  acknowledged or otherwise advanced.
- Diffing belongs in core. Plugins may provide textual snapshots, but core owns
  diff computation and snapshot transition semantics.
- A monitor without a source is usually a design smell. Flag code paths that
  silently tolerate impossible monitor states unless the behavior is clearly
  intentional and documented.

When reviewing runtime changes, prioritize restart safety, event retention, and
projection correctness over code-style concerns.
