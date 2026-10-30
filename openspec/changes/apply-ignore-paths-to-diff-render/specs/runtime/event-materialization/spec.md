## MODIFIED Requirements

### Requirement: Diff rendering of command-poll ignore-paths fields

For an object whose `change-detection.strategy` is `json-diff` and whose snapshot metadata carries
`command-poll`'s `change-detection.ignore-paths`, the system SHALL strip those fields from both the
previous and current snapshot before rendering `diffText` (including per-recipient and claim-time
`net` recomputations), so the rendered delta never contains a field that did not decide whether a
change occurred.

#### Scenario: Ignored field and a real field change together

- **GIVEN** a `command-poll` monitor with `strategy: json-diff` and `ignore-paths` covering `duration`
- **WHEN** both `duration` and a real field change
- **THEN** the change is detected and `diffText` includes the real change but not the `duration` change

#### Scenario: Ignored churn cannot push a real change past the cap

- **GIVEN** a snapshot where 25 ignored fields churn and one real field changes
- **WHEN** the change is materialized
- **THEN** `diffText` contains the real change and no `more changes elided` marker caused by ignored fields

#### Scenario: Claim-time net recomputation honors ignore-paths

- **WHEN** a `net` recipient's collapsed delta is recomputed at claim for such an object
- **THEN** the recomputed `diffText` also excludes the ignored fields
