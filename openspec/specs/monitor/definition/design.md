# monitor/definition — design notes (non-normative)

Durable authoring rationale for current behavior. The normative contract is `spec.md`.

## Why the monitor definition is the root object

Runtime scheduling, source execution, hook delivery, schema generation, and validation all derive
from authored monitor data, so a `MONITOR.md` is the root object of the delivery pipeline, not a
configuration convenience (PP2, SP1, AP6). Its ID is derived from the path (never declared) so that
it is stable and cannot drift from the file's location; uniqueness is a hard error because runtime
state is keyed by `monitorId` and an alias would silently corrupt persisted source/notify state (SP2).

## `watch.type` names intent, not mechanism

`file-fingerprint`, `api-poll`, `schedule`, `incoming-changes` describe _what_ to observe. This
removes the "which event do I subscribe to?" question from the authoring surface.

## CEL for `shape.derive.when`, jq for `payload.transform`

`when` is a _condition_ (boolean selection), so it uses CEL, which is structurally pure (no I/O, no
clock). jq is reserved for extraction/reshaping. Both evaluators were chosen to be free of the
`Function` constructor and `eval`, the same constraint that drove `@cfworker/json-schema` over `ajv`.
The rendered Shape artifact is markdown-ish text rather than JSON so that the diff is semantic and
cheap.

## Choosing a `baseline-strategy`

- `net` (default since 2026-06-19, Refs #110) fits the vast majority of monitors: the recipient wants
  where things stand now relative to its last baseline. Spec documents are the archetype.
- `incremental` is the explicit opt-out when the _sequence_ carries meaning — e.g. comment threads,
  where each reply is a discrete step.

## Rollup cadence pairing

A `rollup` monitor gains nothing from low-latency observation: if delivery is once daily, polling
every 30 seconds only costs observation and tokens. Authors should pair `rollup` with a relaxed
`watch.interval` (e.g. `1h`) and `urgency: low` (a background digest, not an interrupt). The runtime
deliberately does not enforce this.

## Overlapping monitors multiply interrupts (issue #441)

Two monitors over overlapping state (the same command filtered two ways, or two queries over the same
collection such as "ready-to-merge PRs" and "all open PRs") turn one real-world change into multiple
durable events, even where cross-monitor delivery coalescing reduces how many interrupt a turn.
Authoring discipline (not detected by `validate` today):

- Author **one** monitor over the full set whose body branches on what changed ("if labeled
  ready-to-merge, do X; otherwise, if it needs review, do Y").
- When two monitors genuinely need different urgencies or cadences, make their filters **disjoint**
  (the normal-urgency monitor excludes what the high-urgency one covers).

A `command-poll` argv-prefix overlap heuristic in `validate` is a plausible future check; it is not a
committed target.
