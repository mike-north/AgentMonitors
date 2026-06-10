# Agent Monitors — Specification Set

This directory is the **canonical implementation contract** for Agent Monitors: a
system that turns external changes into durable, queryable work signals for AI agents.

Public website docs (`apps/website`) are explanatory and may simplify or lag. When the
website and these specs disagree, **these specs win** (PP8). When these specs and the
current code disagree, each spec says explicitly which behavior is _current_ and which is
_target_ (PP7).

## Reading order

Read top to bottom the first time; after that, jump to the doc that owns your concern.

| Doc                                                                         | Owns                                                                                                                                                | Read when                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [000 — Principles & Properties](./000-principles.md)                        | The invariants (PP/SP/AP/BP/NP) every other doc cites                                                                                               | Always first — the rest reference these by ID                                |
| [001 — Monitor Definition & Authoring](./001-monitor-definition.md)         | `MONITOR.md` layout, frontmatter schema, identity, notify shapes                                                                                    | Authoring monitors; changing the frontmatter schema                          |
| [002 — Runtime, Delivery & Persistence](./002-runtime-delivery.md)          | Tick loop, scheduling, notify dispatch, event materialization, session projection, hook state, delivery lifecycles, daemon/IPC, adapters, DB schema | Anything about _when_ a signal becomes durable and _how_ it reaches an agent |
| [003 — Source Plugins](./003-source-plugins.md)                             | The source contract and the bundled `file-fingerprint` / `api-poll` / `schedule` / `incoming-changes` sources                                       | Writing a source; changing observation behavior                              |
| [004 — Validation & Testing](./004-validation-testing.md)                   | Validation surfaces, required test scenarios, ambiguity/drift handling                                                                              | Adding tests; resolving a contradiction                                      |
| [005 — CLI Reference](./005-cli-reference.md)                               | The `agentmonitors` command surface                                                                                                                 | Using or changing a CLI command                                              |
| [006 — Agent Integration & Delivery Transports](./006-agent-integration.md) | The adapter/transport seam, the hook-state transport, the Claude Code channel transport (target), availability/fallback                             | Adding/changing how deliveries reach an agent (hooks, channels, new hosts)   |

## Normative vs supporting docs

- **Normative** (`000`–`006`): use MUST / MUST NOT / MAY. These define the contract.
- **Supporting** (non-normative), this directory:
  - [glossary.md](./glossary.md) — one canonical definition per core term.
  - [roadmap.md](./roadmap.md) — the current→target gaps, as prioritizable work items.
  - [spec-changelog.md](./spec-changelog.md) — clarifications and contradiction resolutions.
  - [maintainer-migration-notes.md](./maintainer-migration-notes.md) — how the old single-page
    draft maps to this set.

## How to propose a change

Follow the drift-handling process in [004 §5](./004-validation-testing.md) and the acceptance
checklist in [004 §6](./004-validation-testing.md). In short:

1. Update the relevant numbered doc first. Keep _current_ vs _target_ explicit.
2. If the change resolves a contradiction or alters an earlier statement, add a
   [spec-changelog.md](./spec-changelog.md) entry.
3. Add or update tests so the decision is enforced ([004 §3](./004-validation-testing.md)).
4. Only then adjust public website summaries if needed.

Every substantive normative change must be able to answer all five acceptance-checklist
questions in [004 §6](./004-validation-testing.md). If any answer is "no", it is underspecified.

## Source layout (orientation)

The contract is implemented across a pnpm + Nx monorepo:

- `libs/core` (`@agentmonitors/core`) — parser, schema, source registry, runtime, hook bridge,
  adapters, persistence. The published library and the home of most normative behavior.
- `apps/cli` (`agentmonitors`) — the command surface and the daemon/IPC layer.
- `plugins/source-*` — the four bundled observation sources (`file-fingerprint`, `api-poll`, `schedule`, `incoming-changes`).
- `apps/website` — public docs (out of scope for this spec set).
