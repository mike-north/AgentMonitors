## ADDED Requirements

### Requirement: Fresh-install E2E proves the channel path from a global install

A fresh-environment E2E, run in CI on every PR, SHALL globally install the packed `agentmonitors` launcher into an isolated npm prefix with no workspace `node_modules` access, bootstrap a project with `agentmonitors init`, fire a `file-fingerprint` monitor, and confirm the signal reaches a client over the real channel transport contract (per `delivery/channel-transport`).

#### Scenario: Install to first channel signal

- **GIVEN** every publishable package packed to tarballs and the launcher installed from them into an empty npm prefix
- **WHEN** a fresh project is initialized, a channel client is connected for a session, and a watched file is changed
- **THEN** the client receives the monitor's signal over the channel transport

#### Scenario: Launcher entry point is exercised

- **WHEN** the channel E2E invokes the CLI
- **THEN** it runs the launcher package's own installed entry point, not the global `agentmonitors` bin symlink
