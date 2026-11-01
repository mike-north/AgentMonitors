## Why

A `shape` declaration must be a pure function of `(snapshot, now)`: any other input produces phantom
diffs downstream. CEL is structurally pure and a malformed predicate is already rejected, but a
well-formed `shape.derive[].when` that references an identifier outside the shaped snapshot and `now`
(a typo'd field name, an assumed ambient variable) is accepted today and silently evaluates to "fact
does not hold" on every tick. The author gets no signal that the derived fact can never fire.

Source: 001 §5.1 ("Determinism is a validation obligation" — static rejection remains target) and the
remaining target piece of 004 §2.2 ("Target extension"). No GitHub issue is filed for this yet.

## What Changes

- Parse-time validation — and therefore `agentmonitors validate`, `monitor test`, and `watch declare`
  — rejects a `shape.derive[].when` CEL predicate that references an identifier outside the shaped
  snapshot and the injected `now`, naming the identifier and the `shape.derive.<index>.when` path;
  `validate` exits 1.
- A predicate whose identifiers are in scope but whose field is absent from a particular snapshot
  still deterministically yields "fact does not hold" at evaluation.
- The current, intentionally preserved limit (out-of-scope identifiers are never rejected at parse
  time) is removed from both `monitor/definition` and `monitor/validation`.
- Not part of this change: the other 004 §2.2 "target extension" items (transform under a
  non-`structured` form, malformed `jq`/`cel`, unknown `form`/`language`/`encoding`) are already
  implemented and specified as current behavior.

Principles: relies on PP10 (deterministic daemon floor), PP2, and BP3 (validation catches authoring
mistakes early; runtime execution stays the final authority). Resolves a contradiction: 004 §2.2
described all shape/payload validation as target while 001 §5.1–§5.2 and the code show everything
except identifier-scope checking is current; this change carries only the genuinely unimplemented part.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `monitor/definition`: replaces "Unresolvable predicate identifiers evaluate as not holding" with an
  authoring-time rejection for out-of-scope identifiers plus an evaluation-time rule for absent
  snapshot fields.
- `monitor/validation`: replaces "Validate does not statically check shape predicate identifier
  scope" with the `validate`-surface rejection (error path, exit code).

## Impact

- Code: `libs/core/src/schema/monitor-schema.ts` (`shape` refinement), `libs/core/src/runtime/shape.ts`
  (predicate validation helper), `apps/cli` `validate`.
- Open question (see `design.md`): how the validator learns the set of identifiers a source's snapshot
  can carry. The predicate context exposes snapshot fields as bare top-level identifiers alongside
  `now`, and a source's snapshot keys are not known statically.
- User-visible: monitors that validate today may start failing `validate`; needs a changeset and a
  website docs update.
