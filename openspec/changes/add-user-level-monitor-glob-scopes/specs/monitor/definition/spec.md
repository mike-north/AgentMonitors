## ADDED Requirements

### Requirement: User-level file-fingerprint monitors declare workspace-agnostic globs

A `file-fingerprint` `MONITOR.md` placed in a user-level monitors root (the global config root rather than a project `.claude/monitors/` directory) SHALL declare its `globs` with absolute (`/…`) or home-relative (`~`, `~/…`) patterns. Scope classes, `~` expansion, mixing, and `validate` rejection rules are owned by the `sources/file-fingerprint` capability; project-level monitors are unaffected.

#### Scenario: Home-relative user-level monitor

- **WHEN** a user-level monitor named `Personal Notes Changes` declares `watch: { type: file-fingerprint, globs: ['~/notes/**/*.md'], interval: 30s }`, `urgency: normal`, `notify: { strategy: debounce, settle-for: 30s }`
- **THEN** `agentmonitors validate --user-level` accepts it
- **AND** its events are workspace-agnostic (`workspacePath: null`) and project into every lead session

#### Scenario: Project-level authoring is unchanged

- **WHEN** a monitor in a project `.claude/monitors/` directory declares `globs: ['src/**/*.ts']`
- **THEN** it is authored and validated exactly as before this change
