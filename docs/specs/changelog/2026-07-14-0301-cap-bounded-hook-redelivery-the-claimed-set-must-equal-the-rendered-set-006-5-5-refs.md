## 2026-07-14 — Cap-bounded hook redelivery: the claimed set must equal the rendered set (006 §5.5) — Refs #299

Spec 006 §5.5 promised that a high-urgency event truncated out of the 4000-char hook
`additionalContext` "re-delivers via the next context event", but the implementation claimed the
**full** settled candidate set before the render truncated it. A truncated-away event therefore had
`first_notified_at` set (claimed) while the pending-turn delivery selects only rows whose
`first_notified_at` is NULL — so it stayed unread yet was **never** re-surfaced automatically. That
is silent P1 signal loss for exactly the sessions with the most pending work, and it contradicted
the section's own guarantee.

- **006 §5.5 — rewritten & retitled (current).** "Unread-recoverability" is now
  "Unread-recoverability & cap-bounded redelivery" and states the contract explicitly: **the claimed
  set MUST equal the rendered set.** A length-bounded transport PREVIEWS the settled high-urgency
  delivery without mutating state (`previewSettledHighDelivery`), sizes how many WHOLE event blocks
  fit under the cap (reserving marker room; never a partial block), then claims exactly that many
  (`claimDelivery`'s `maxEvents`). The deferred remainder stays pending (`first_notified_at` NULL)
  and re-delivers in order at the next context event; every event also remains unread (claiming ≠
  acking, BP2 / SP4) until explicitly acknowledged. The truncation marker is appended whenever any
  pending event is omitted (block did not fit or transport deferred more). Non-high branches
  (reminders, `post-compact` recap) and uncapped callers (the channel transport) are unchanged.
- **No behavior change to acknowledgement, urgency, or projection** — only which events a capped
  `turn-interruptible` claim marks claimed now matches what it renders.

