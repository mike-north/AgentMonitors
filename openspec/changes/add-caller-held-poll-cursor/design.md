## Context

003 §13 records the caller-held cursor as a **sketch**, adopted from #81 as the principled poll-cost
optimization if poll cost ever measurably bites. It generalizes the stateful baseline sources already
keep: examples of cursor-answering tools are `git <cursor>..HEAD`, `kubectl --resource-version`, and
a task CLI's change generation.

## Decisions

- **Cursor lives in the existing `nextState` slot.** No new persistence; the cursor is per-monitor
  source state like any other baseline (PP6).
- **Sequencing (from #81).** `command-poll` (shipped) first, measure poll cost, and design this fully
  only against observed cost. This change is not a roadmap item until a measurement justifies it.

## Alternatives rejected

- **Cache command output between runs.** Rejected in favor of the cursor: caching adds hidden state
  and staleness without making the polled tool cheaper.
- **Gate execution on file mtimes.** Rejected: ties change detection to filesystem side channels
  rather than to where the data lives.
- **Hidden cross-invocation state inside the polled tool.** Rejected: the cursor is caller-held so
  the tool stays stateless.

## Open Questions

- How the cursor interacts with snapshot semantics: a "changes since" response is a delta, while the
  source contract requires current-state snapshots with the runtime as sole diff producer.
- Whether `api-poll` adopts the same protocol (e.g. a `{{state}}` placeholder in URLs/query).
- `next-state` path syntax (presumably the keyed-collection dotted path) and behavior when it is
  missing from the output.
- Behavior when a cursor is rejected or invalidated upstream (re-baseline vs. error).
