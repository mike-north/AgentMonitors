# Agent Monitors — Specification

The **canonical implementation contract** for Agent Monitors is the OpenSpec specification in
[`openspec/`](../../openspec/):

- [`openspec/specs/<capability>/spec.md`](../../openspec/specs/) — **current** (implemented)
  behavior, as requirements (`SHALL` / `MUST`) with testable scenarios.
- [`openspec/changes/<change>/`](../../openspec/changes/) — **target** (not-yet-implemented)
  behavior: a `proposal.md`, delta specs, `tasks.md`, and optionally a `design.md`. The set of open
  changes is the roadmap.
- [`openspec/config.yaml`](../../openspec/config.yaml) — project context and the rules each
  artifact must follow.

Public website docs (`apps/website`) are explanatory and may simplify or lag. When they disagree
with OpenSpec, **OpenSpec wins** (PP8).

## Finding the right capability

```bash
openspec list --specs                       # every capability and its requirement count
openspec show delivery/lifecycles --type spec   # read one capability
openspec list                               # open (target) changes
```

| Domain                    | Capabilities                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invariants                | `principles` (PP/SP/AP/BP/NP — cited by ID everywhere else)                                                                                                                                     |
| Authoring                 | `monitor/definition`, `monitor/validation`                                                                                                                                                      |
| Runtime                   | `pipeline/post-processing`, `runtime/tick-scheduling`, `runtime/monitor-state`, `runtime/local-data-permissions`, `runtime/notify-dispatch`, `runtime/event-materialization`                    |
| Delivery                  | `delivery/session-projection`, `delivery/lifecycles`, `delivery/host-adapters`, `delivery/transport-seam`, `delivery/hook-transport`, `delivery/channel-transport`, `delivery/transport-health` |
| Daemon & storage          | `daemon/ipc`, `persistence/schema`, `inbox/legacy-inbox`                                                                                                                                        |
| Sources                   | `sources/contract`, `sources/file-fingerprint`, `sources/api-poll`, `sources/schedule`, `sources/incoming-changes`, `sources/command-poll`                                                      |
| CLI                       | `cli/conventions`, `cli/authoring-commands`, `cli/monitor-commands`, `cli/daemon-commands`, `cli/session-commands`, `cli/doctor`, `cli/verify`                                                  |
| Agent-facing              | `agent/ephemeral-monitors`                                                                                                                                                                      |
| Reliability & engineering | `reliability/process-hygiene`, `engineering/test-integrity`                                                                                                                                     |

## How to change behavior

1. Propose an OpenSpec change (`/opsx:propose` in Claude Code; `openspec-propose` skill elsewhere):
   proposal, delta specs (`ADDED` / `MODIFIED` / `REMOVED` requirements), tasks.
2. Implement it with its tests (`/opsx:apply`), in the same PR as the change, or a later one.
3. When it ships, archive it (`/opsx:archive`): its deltas are merged into `openspec/specs/` and the
   change moves to `openspec/changes/archive/`. Main specs describe current behavior only.
4. `openspec validate --all --strict` must pass.

Clarifications that do not change behavior may edit `openspec/specs/` directly.

## What remains in this directory (non-normative)

- [glossary.md](./glossary.md) — one canonical definition per core term.
- `000`–`008` (e.g. [002](./002-runtime-delivery.md)) — **crosswalk stubs**. The former numbered
  docs are still cited throughout code comments as `NNN §X.Y`; each stub maps every former section
  to the capability (and requirement names) or change that now owns it. Their full former text is in
  git history (`git show e1bafcfa:docs/specs/<file>`).
- [roadmap.md](./roadmap.md) — maps the former gap IDs (`G1`…`G21`) to changes or capabilities.
- [spec-changelog.md](./spec-changelog.md) — the frozen pre-OpenSpec history of clarifications and
  contradiction resolutions. New history is the archived changes in `openspec/changes/archive/`.
- [maintainer-migration-notes.md](./maintainer-migration-notes.md), [design/](./design/),
  [plans/](./plans/) — historical design records.
