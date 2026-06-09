---
title: Use Cases & Journeys
description: Real monitoring patterns from five-line basics to fleet supervision, with progressive disclosure built in.
---

# Use Cases & Journeys

These are the bread-and-butter patterns Agent Monitors is designed for, ordered from
simplest to most powerful. Every advanced example is the simple one with additive blocks —
none of the originals lines change.

## The design law: progressive disclosure

Power features are discovered when a specific friction is hit — never presented up front.
The base unit is valid with zero optional fields. A `watch:` block plus a body is a
complete, working monitor.

## Case A — watch a thing for change

_"When this external thing changes, check my code against it."_

```yaml
---
name: Watch the upstream API spec
watch:
  type: api-poll
  url: https://api.vendor.com/openapi.json
---
The upstream API spec changed. Diff it against my client in `src/api/` and
flag any breaking changes I need to handle.
```

Five lines. The body carries the meaning; the agent does the reasoning. No filter,
no formatting — this is the complete monitor.

## Case B — incoming changes (the dogfood case)

_"When a `git pull` changes files I depend on, tell me what changed."_

```yaml
---
name: Spec changes from upstream
watch:
  type: incoming-changes
  paths: 'docs/specs/**'
---
The spec documents changed in the latest pull. Summarize what changed and
whether it affects what I'm currently working on.
```

This keys off the **commit graph advancing** — so the signal carries provenance (someone
else's change) rather than being ambiguous with your own edits.

## Case C — file change watcher

_"Whenever these config files change, review them."_

```yaml
---
name: Config drift detector
watch:
  type: file-fingerprint
  globs:
    - 'tsconfig.json'
    - 'package.json'
urgency: normal
---
Config files changed. Check whether the change affects build output or
dependencies, run `pnpm check`, and update any documentation that
references the changed configuration.
```

## Case D — scheduled check-in

_"Every weekday morning, remind me to review the overnight queue."_

```yaml
---
name: Daily backlog review
watch:
  type: schedule
  cron: '0 9 * * 1-5'
  timezone: America/New_York
urgency: low
---
Review the overnight inbox and triage anything that arrived. Flag anything
that needs immediate attention before the standup.
```

## The progressive disclosure journey

Take Case B forward. At each step the author adds **one block** — the original lines are
untouched:

| Friction the author hits | What is revealed | Block |
|---|---|---|
| "It fires on trivial whitespace churn" | Event filtering | `when:` |
| "Just 'these files changed' — I want the diff" | Diff / context formatting | `deliver:` |
| "For a careful review I need full before/after" | Point-in-time snapshots | `deliver:` |
| "This actually has to get reconciled, reliably" | Reliable reaction | `until:` |
| "Interrupt me now vs. whenever" | Urgency | top-level field |

The power user version of Case B, fully annotated:

```yaml
---
name: Spec changes from upstream
watch:
  type: incoming-changes
  paths: 'docs/specs/**'
urgency: high
when:
  changed: [content]       # ignore formatting-only churn
deliver:
  context: hunks           # include the actual diff
  snapshot: before-and-after
until:
  satisfied-when: 'my notes reconciled with the new spec'
---
The spec documents changed in the latest pull. Summarize what changed and
whether it affects what I'm currently working on.
```

The base lines (`watch:` + body) are identical to Case B. All power is in additive blocks.

## The ceiling — fleet supervision

The same `watch:` + body model stretches all the way to supervising parallel agents:

```yaml
---
name: Catch dissonant parallel edits
watch:
  type: incoming-changes
  paths: 'src/**'
---
Two agents have both modified overlapping code. Compare their diffs and
decide whether they are in tension. If so, alert me with a concise summary;
if benign, stay quiet.
```

The _only_ new thing this advanced case needs is the `type`. All the intelligence —
"are these in tension?", "alert me" — is **body prose**, run by the agent. The format
reaches from "tell me when the specs change" to "supervise a fleet for semantic conflict"
without adding a single field to the simple case.

## The boundary that keeps it honest

Frontmatter states facts; the body states judgments. The monitor observes and delivers
mechanical facts (declared in frontmatter); all semantic judgment is authored in the body
and executed by the agent. The runtime carries the body through verbatim — it never acts
on it. This is enforced by the file's shape, not by discipline.
