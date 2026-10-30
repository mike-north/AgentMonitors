## ADDED Requirements

### Requirement: command-poll cursor block

`command-poll` SHALL accept an optional `cursor` block with `initial` (the cursor value used when no prior state exists) and `next-state` (a path extracted from the parsed output after each run). Each `{{state}}` placeholder in `command` SHALL be replaced with the current cursor before execution, and the extracted `next-state` value SHALL be stored as the cursor for the next run.

#### Scenario: First run uses the initial cursor

- **GIVEN** `command: ['ofocus', 'changes', '--since', '{{state}}', '--json']` and `cursor: { initial: '0', next-state: '$.cursor' }`
- **WHEN** the monitor runs with no prior state
- **THEN** the executed argv is `ofocus changes --since 0 --json`

#### Scenario: Next run uses the extracted cursor

- **GIVEN** the previous run's parsed output had `cursor: '17'`
- **WHEN** the monitor runs again
- **THEN** the executed argv is `ofocus changes --since 17 --json`
