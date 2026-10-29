## Context

001 §5.1 states that statically rejecting a `when` predicate referencing an identifier outside the
snapshot and `now` "remains target"; today such a reference evaluates to "fact does not hold" (a
deterministic, snapshot-only outcome) rather than a parse-time rejection.

## Decisions

- Keep the evaluation-time "does not hold" fallback for fields that are in scope but absent from a
  given snapshot. Rejected alternative: raising at evaluation — it would turn ordinary data variation
  (an optional field) into tick failures.

## Open Questions

- The source docs do not say how the validator determines the identifier set of a snapshot. Options
  include a per-source declared snapshot shape or treating any top-level identifier other than `now`
  as a snapshot field (which would make the check vacuous). This must be settled before
  implementation; the delta specifies only the observable contract.
