## ADDED Requirements

### Requirement: Validate rejects shape predicates referencing identifiers outside snapshot and now

`agentmonitors validate` MUST reject a monitor whose `shape.derive[].when` CEL predicate references an identifier outside the shaped snapshot and the runtime-injected `now`, reporting the offending identifier and the `shape.derive.<index>.when` path, and exiting with code 1.

#### Scenario: Out-of-scope identifier rejected

- **WHEN** a monitor declares `shape: { derive: [{ name: stale, when: "env.HOME != ''" }] }`
- **THEN** `validate` reports an error at `shape.derive.0.when` naming the identifier `env`
- **AND** the exit code is 1

#### Scenario: Predicate over now is accepted

- **WHEN** a monitor's predicate references only snapshot fields and `now`
- **THEN** `validate` reports the monitor as valid

## REMOVED Requirements

### Requirement: Validate does not statically check shape predicate identifier scope

**Reason**: Replaced by static rejection of predicates that reference identifiers outside the snapshot and `now`.
**Migration**: Rewrite any `shape.derive[].when` predicate that references a non-snapshot identifier to use only snapshot fields and `now`; such predicates never held at runtime anyway.
