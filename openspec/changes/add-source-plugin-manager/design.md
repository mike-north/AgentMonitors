## Context

The CLI registers only the five bundled sources (`registerCoreSources`). Third-party plugins are
an architectural concept (003 §7–§8) with no install path; the `source` placeholders print
`pnpm add --prefix ~/.config/agentmonitors <package-name>` as the manual workaround. Roadmap G4
names two acceptable resolutions and leaves the choice open.

## Goals / Non-Goals

**Goals:** a CLI-driven way to discover, install, update, and remove third-party source plugins
whose sources then participate in `validate`, `schema generate`, `source list`, and the runtime
exactly like bundled sources (AP4).

**Non-Goals:** changing the source plugin contract itself (`sources/contract`), or adding a
hosted plugin registry.

## Decisions

- **Undecided: plugin manager vs. explicit manual-install decision.** Roadmap G4 accepts either
  "a real plugin manager (discovery + install/update/remove) wired to the registry" or "an
  explicit decision to keep manual installation and remove the placeholders". This change is
  written for the first option; the owner must confirm before implementation.

## Alternatives

- **Keep manual installation and remove the placeholders.** Not rejected; it is the roadmap's
  named alternative. Choosing it would turn this change into REMOVED requirements for the four
  placeholder commands plus a documented manual-install path, and NP3 would stay normative.
- **Keep the placeholders indefinitely.** Rejected by the roadmap: a command that always exits 1
  advertises a capability the product does not have.

## Open Questions

- Discovery source for `source search` (npm registry query, keyword convention, curated list).
- Install location (the placeholder hint uses `~/.config/agentmonitors`) and how the CLI and
  daemon load installed plugins at startup.
- Whether a running daemon must be restarted to pick up an installed/removed source.
