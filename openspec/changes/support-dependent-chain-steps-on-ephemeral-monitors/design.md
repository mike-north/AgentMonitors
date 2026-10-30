## Context

007 §4.7 fixes only the ephemeral primitive's obligations toward dependent chains (#124): a chain
step is an ephemeral monitor the daemon registers when the prior step fires; it is session-scoped,
daemon-armed, and reaped when satisfied or when the session ends. The chain-authoring surface is
explicitly out of scope for the primitive.

## Decisions

- **Chains build on the ephemeral primitive.** Rejected alternative: a separate chain engine with
  its own state — rejected because it would be a parallel system, violating AP7's "one pipeline,
  two authoring paths".
- **`--until` is not part of the `watch` primitive.** An earlier draft of the `watch` signature
  listed a fire-condition `--until` flag; it was deferred to the chain-authoring work when `watch`
  shipped (Refs #312), so the current `watch` surface stays declaration-only.

## Open Questions

- **Chain-authoring surface (#124).** How a chain is declared (CLI verb, `MONITOR.md` frontmatter, or
  both) and how a step is linked to its predecessor.
- **Fire condition / "satisfied" semantics.** What the `--until` fire-condition expresses and what
  makes a step "satisfied" (first event? a predicate over the event?) is not defined by the source
  docs and must be pinned by the #124 design before build.
- **Identity of daemon-armed steps.** Whether a daemon-armed step reuses the `ephemeral:<sessionId>/<ulid>`
  scheme unchanged (assumed in the delta) or encodes its chain.
