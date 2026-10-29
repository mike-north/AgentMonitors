## ADDED Requirements

### Requirement: Out-of-scope shape predicate identifiers are rejected

Because a `shape` declaration MUST be a pure function of `(snapshot, now)`, parse-time validation and
`agentmonitors validate` MUST reject a well-formed `shape.derive[].when` CEL predicate that references
an identifier outside the shaped snapshot and the runtime-injected `now`, reporting the error on that
entry's `when`.

#### Scenario: Ambient identifier rejected

- **WHEN** a derive rule declares `when: 'due < today'` and `today` is neither a snapshot identifier nor `now`
- **THEN** `agentmonitors validate` exits non-zero with an error at `shape.derive.0.when` naming `today`

#### Scenario: In-scope identifiers accepted

- **WHEN** a derive rule declares `when: 'now <= due && due <= now + 48h'` and `due` is a snapshot identifier
- **THEN** validation succeeds

### Requirement: Absent snapshot fields evaluate as not holding

A predicate whose identifiers are all in scope SHALL still deterministically yield "fact does not
hold" when a referenced field is absent from the particular snapshot being evaluated; this MUST NOT
raise an error at evaluation.

#### Scenario: Field missing from one snapshot

- **WHEN** a derive rule declares `when: "priority == 'high'"` and one observed snapshot has no `priority` field
- **THEN** the fact does not hold for that snapshot and evaluation continues without error

## REMOVED Requirements

### Requirement: Unresolvable predicate identifiers evaluate as not holding

**Reason**: Out-of-scope identifiers are now rejected at validate time; the evaluation-time behavior
for in-scope-but-absent fields is restated by "Absent snapshot fields evaluate as not holding".
**Migration**: Monitors whose `when` predicates reference identifiers outside the snapshot and `now`
fail `agentmonitors validate`; authors fix the identifier (usually a typo) or remove the rule.
