# Use Cases & Journeys

> **Status:** Draft
> **Purpose:** the bread-and-butter journeys we optimize for, and the discipline that keeps
> them simple as power is layered on. Companion to the
> [standard](../standard/monitor-md-standard.md) (the _format_) and the
> [vision & positioning](./vision-and-positioning.md) (the _why_).

> **A note on syntax.** Examples use the standard's target `watch: { type }` authoring shape.
> Today's runtime still uses the mechanism-first `source:` / `scope:` frontmatter; aligning
> the two is tracked separately. The _journeys_ below are stable regardless.

## The design law: progressive disclosure

The bread-and-butter cases must be trivial, and stay trivial forever, even as we add event
filtering, custom formatting, diff context, point-in-time snapshots, and reliable reactions.
That holds only if we obey four rules:

1. **The base unit is valid with zero optional fields.** A `watch:` block plus a body is a
   complete monitor. The test: delete every optional block and it still works.
2. **Defaults disappear.** A simple monitor is the _absence_ of knobs — never knobs set to
   "default."
3. **Power lives in contained blocks, not top-level flags.** A power user _adds a block_; a
   simple user simply doesn't have it. The blocks cluster into two intents — **`when:` (fire
   less)** and **`deliver:` (say more)** — plus **`until:` (reliability)**.
4. **It holds across schema _and_ scaffold _and_ docs _and_ errors.** If `init` scaffolds a
   kitchen-sink template, or the quickstart shows the advanced form, or a validation error
   dumps the full schema, the simple path is polluted even with a clean schema.

> **The invariant that guards it:** no power feature may add a _required_ field to the base,
> change the meaning of a base field, or appear in the default scaffold/quickstart. Power is
> additive opt-in blocks with disappearing defaults, revealed only at the friction moment
> that motivates them.

## Bread-and-butter A — watch a thing for change

_"When this external thing changes, check my code against it."_

```yaml
---
name: Watch the upstream API spec
watch:
  type: url
  url: https://api.vendor.com/openapi.json
---
The upstream API spec changed. Diff it against my client in `src/api/` and
flag any breaking changes I need to handle.
```

The body carries the meaning; the agent does the reasoning. No filter, no formatting — the
five lines _are_ the monitor.

## Bread-and-butter B — incoming changes (the dogfood case)

_"When a `git pull` changes files I depend on, tell me what changed."_ This is the case we
dogfood on this repo (tracking issue #43).

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

What makes this its own case (not "watch files"): it keys off the **commit graph advancing**,
not file mtime — so it can attribute the change to a pull/merge (someone else) rather than
your own edit. _Provenance is the point._

## The journey: simple stays simple, power reveals on friction

Power features are discovered when a specific friction is hit — never presented up front.
Take case B forward; at each step the author **adds one block**, and the original lines are
untouched:

| Friction the author hits                        | What's revealed         | Block       |
| ----------------------------------------------- | ----------------------- | ----------- |
| "It fires on trivial whitespace churn"          | event filtering         | `when:`     |
| "Just 'these files changed' — I want the diff"  | diff/context formatting | `deliver:`  |
| "A changed `$ref` without what it points to"    | context around the diff | `deliver:`  |
| "For a careful review I need full before/after" | point-in-time snapshots | `deliver:`  |
| "This actually has to get reconciled, reliably" | reliable reaction       | `until:`    |
| "Interrupt me now vs. whenever"                 | urgency                 | (top-level) |

```yaml
# The base (name + watch + body) never changes. A power user only ADDS:
when:
  changed: [content] # ignore formatting-only churn
deliver:
  context: hunks # include the actual diff
  snapshot: before-and-after # attach point-in-time states
until:
  satisfied-when: 'my notes reconciled with the new spec'
```

A reader instantly knows where any _future_ feature belongs (fire less → `when:`, say more →
`deliver:`), and the simple author sees none of it.

## The ceiling: it stretches without polluting the floor

The far end — supervising parallel agents — uses the same bones:

```yaml
---
name: Catch dissonant parallel edits
watch:
  type: worktree-contention # mechanical: code touched by >1 active worktree
---
Two agents have both modified overlapping code. Compare their diffs and decide
whether they're in tension. If so, alert me with a concise summary; if benign,
stay quiet.
```

The _only_ new thing this advanced case needs is the mechanical `type`. Every bit of
intelligence — "are these in tension?", "alert me" — is **body prose**, run by the agent.
The model reaches from "tell me when the specs change" to "supervise a fleet for semantic
conflict" without adding a single field to the simple case.

## The boundary that keeps it honest

That last example illustrates the rule that makes all of this work, and it is enforced by
the file's shape, not by discipline:

> **Frontmatter states facts; the body states judgments.** The monitor observes and delivers
> _mechanical_ facts (declared in frontmatter); all _semantic_ judgment is authored in the
> body and executed by the agent.

You cannot accidentally put reasoning into the monitor, because the runtime only
_interprets_ the frontmatter — the body is carried through to the agent verbatim, never
acted on by the runtime itself. See the matching non-goal in
[vision & positioning](./vision-and-positioning.md).
