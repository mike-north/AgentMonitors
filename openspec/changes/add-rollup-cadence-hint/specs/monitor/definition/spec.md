## ADDED Requirements

### Requirement: Rollup cadence hint

When a `notify: { strategy: rollup }` monitor's `watch.interval` is set tighter than its delivery
`window`, authoring tooling (`agentmonitors validate`) SHOULD surface a non-fatal hint suggesting a
relaxed interval. The hint MUST NOT fail validation, change the exit status, or alter the monitor's
observation cadence.

#### Scenario: Tight interval on a daily digest

- **WHEN** `agentmonitors validate` checks a monitor with `watch: { type: api-poll, url: 'https://api.example.com/updates', interval: 30s }` and `notify: { strategy: rollup, window: '0 9 * * 1-5' }`
- **THEN** it prints a hint that the interval is tighter than the delivery window
- **AND** it exits 0

#### Scenario: Relaxed interval

- **WHEN** `agentmonitors validate` checks the same monitor with `interval: 1d` (not shorter than the one-day minimum gap between weekday window openings)
- **THEN** no cadence hint is printed
