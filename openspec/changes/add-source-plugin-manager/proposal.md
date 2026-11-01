## Why

`agentmonitors source search|install|update|remove` exist today only as placeholders that print a
"not yet implemented" message and a manual `pnpm add --prefix ~/.config/agentmonitors <name>` hint,
then exit 1. Third-party source plugins are a supported architectural concept, but there is no
CLI workflow to discover, install, update, or remove one (NP3). The roadmap tracks this as gap G4:
either ship a real plugin manager wired to the source registry, or make an explicit decision to
keep manual installation and remove the placeholders.

Source: docs/specs/roadmap.md G4; 005 §7.2–§7.5; 003 §7.1, §8.

## What Changes

- Replace the four placeholder `source` subcommands with working commands:
  - `source search [query]` discovers third-party observation source plugin packages.
  - `source install <name>` installs a plugin package and makes its source available to the
    registry that `validate`, `schema generate`, `source list`, and the runtime use.
  - `source update [name]` updates one installed plugin, or all of them when no name is given.
  - `source remove <name>` uninstalls a plugin package and drops its source from the registry.
- **Open decision (see design.md):** the roadmap allows the alternative of keeping manual
  installation and deleting the placeholders. If that alternative is chosen, this change is
  rewritten to REMOVE the placeholder requirements instead of adding the commands.
- Retires NP3 ("no third-party source discovery or installation") once implemented.

Principles: relies on AP4 (the source registry drives validation and schema generation) and AP6
(CLI behavior derives from core contracts); retires NP3. Does not resolve a spec/code
contradiction: specs and code agree today that these commands are placeholders.

No issue number is recorded for G4.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `cli/authoring-commands`: the `source search`, `source install`, `source update`, and
  `source remove` placeholder requirements are replaced by working plugin-management commands.

## Impact

- `apps/cli/src/commands/source.ts`, `apps/cli/src/sources.ts` (registry population must include
  installed third-party plugins, not only the bundled ones).
- `principles` capability: NP3 must be retired by the owner of that capability when this ships.
- `sources/contract` capability (003 §7.1/§8) describes registry population and plugin
  installation as not implemented; it needs a matching update.
- `cli/conventions` command inventory: the four commands stop being placeholders.
- Public docs (`apps/website`) and the `@agentmonitors/cli` changeset.
