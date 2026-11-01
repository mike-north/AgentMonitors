## ADDED Requirements

### Requirement: source search discovers source plugins

`agentmonitors source search [query]` SHALL search for third-party observation source plugin packages matching `[query]` (all discoverable plugins when omitted), print each match, and exit 0, including when nothing matches.

#### Scenario: Search with a query

- **WHEN** a user runs `agentmonitors source search rss`
- **THEN** matching source plugin packages are listed and the exit code is 0

### Requirement: source install registers a source plugin

`agentmonitors source install <name>` SHALL install the named source plugin package and make its source available to the source registry used by `validate`, `schema generate`, `source list`, and the runtime, exactly like a bundled source (AP4).

#### Scenario: Installed source becomes valid

- **WHEN** a user runs `agentmonitors source install <pkg>` for a package providing source `rss`
- **THEN** `agentmonitors source list` includes `rss` and a monitor with `watch.type: rss` passes `agentmonitors validate`

### Requirement: source update refreshes installed plugins

`agentmonitors source update [name]` SHALL update the named installed source plugin, or every installed third-party source plugin when no name is given.

#### Scenario: Update all

- **WHEN** a user runs `agentmonitors source update` with no name
- **THEN** every installed third-party source plugin is updated

### Requirement: source remove unregisters a source plugin

`agentmonitors source remove <name>` SHALL uninstall the named source plugin package so its source is no longer in the registry; bundled sources MUST NOT be removable.

#### Scenario: Removed source becomes unknown

- **GIVEN** an installed plugin providing source `rss`
- **WHEN** a user runs `agentmonitors source remove <pkg>`
- **THEN** a monitor with `watch.type: rss` fails `agentmonitors validate` as an unknown source

## REMOVED Requirements

### Requirement: source search placeholder

**Reason**: Replaced by a working `source search` command (roadmap G4).
**Migration**: Use `agentmonitors source search [query]`; the manual `pnpm add --prefix ~/.config/agentmonitors <package-name>` hint is no longer printed.

### Requirement: source install placeholder

**Reason**: Replaced by a working `source install` command (roadmap G4).
**Migration**: Use `agentmonitors source install <name>` instead of a manual `pnpm add`.

### Requirement: source update placeholder

**Reason**: Replaced by a working `source update` command (roadmap G4).
**Migration**: Use `agentmonitors source update [name]`.

### Requirement: source remove placeholder

**Reason**: Replaced by a working `source remove` command (roadmap G4).
**Migration**: Use `agentmonitors source remove <name>`.
