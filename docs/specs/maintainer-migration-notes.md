# Maintainer Migration Notes

> **Status:** Supporting (non-normative)

This document explains how the previous single-page draft and the repository layout map to
the numbered internal spec set in `docs/specs/`. Nothing here is a requirement to preserve
the previous public-page structure.

## 1. Source-of-Truth Move

The previous implementation effort started from a detailed public website page
(`apps/website/src/pages/docs/specification.md`). That page is transitional. The canonical
implementation contract is now the numbered internal doc set in this directory:

- [000-principles.md](./000-principles.md)
- [001-monitor-definition.md](./001-monitor-definition.md)
- [002-runtime-delivery.md](./002-runtime-delivery.md)
- [003-source-plugins.md](./003-source-plugins.md)
- [004-validation-testing.md](./004-validation-testing.md)
- [005-cli-reference.md](./005-cli-reference.md)

plus the supporting [README.md](./README.md), [glossary.md](./glossary.md),
[roadmap.md](./roadmap.md), and [spec-changelog.md](./spec-changelog.md).

The public website pages should remain short summaries that point readers here as the
implementation source of truth. (Reconciling the website was intentionally deferred during
the authoring pass — see [roadmap.md](./roadmap.md).)

## 2. Old Single-Page Sections to New Docs

Approximate mapping from the prior single-page draft:

| Previous topic                          | New home                                                 |
| --------------------------------------- | -------------------------------------------------------- |
| Why Agent Monitors exists               | [000-principles.md](./000-principles.md)                 |
| Monitor file layout and frontmatter     | [001-monitor-definition.md](./001-monitor-definition.md) |
| Runtime polling and scheduling          | [002-runtime-delivery.md](./002-runtime-delivery.md)     |
| Event persistence, sessions, hook state | [002-runtime-delivery.md](./002-runtime-delivery.md)     |
| Source contract and bundled sources     | [003-source-plugins.md](./003-source-plugins.md)         |
| Validation implications                 | [004-validation-testing.md](./004-validation-testing.md) |
| CLI commands                            | [005-cli-reference.md](./005-cli-reference.md)           |

## 3. Runtime vs Inbox Clarification

The biggest structural clarification this spec set introduces is the split between:

- the runtime/session event pipeline, and
- the legacy inbox item lifecycle.

Avoid prose that collapses those into one system unless the code is later changed to make
that statement true. Current source-of-truth wording:

- `monitor_events` + `session_event_state` are the primary runtime delivery path.
- `inbox_items` is still implemented and public, but separate.

## 4. Current Implementation Gaps That Must Stay Explicit

Do not smooth over these in explanatory docs. Each is tracked with a proof obligation in
[roadmap.md](./roadmap.md):

- `low` urgency is implemented even though some older public docs under-emphasize it.
- Duplicate monitor IDs are hazardous even though explicit rejection is not yet implemented (G1).
- `validate` does not yet do full per-source JSON Schema validation (G2).
- `file-fingerprint` does not yet emit file-created/file-deleted events (G3).
- Third-party source-management commands remain placeholders (G4).
- `watch()` is defined but unused by the runtime (G5).
- `observation_history` is defined in the schema but never written (G6).

## 5. How To Update This Spec Set

1. Update the relevant numbered doc first.
2. Add a [spec-changelog.md](./spec-changelog.md) entry if the change resolves ambiguity or
   alters an earlier statement.
3. Update or add tests that prove the changed rule ([004 §3](./004-validation-testing.md)).
4. Only then adjust public website summaries if needed.
