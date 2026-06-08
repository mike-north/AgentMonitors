# The Monitor Standard — `MONITOR.md`

> **Status:** Draft v0 (proposal)
> **Audience:** anyone implementing a runtime, a source, or a host adapter that
> produces or consumes monitor signals — not just this repository.

A **monitor** is a declarative, host-agnostic unit that turns a kind of external change
into a well-timed, actionable signal for an agent. You declare _what to watch_ and _what
it means for you_; a conformant runtime handles observation, change-detection, durability,
and delivery.

This document defines the **unit**, the **change vocabulary**, and the **signal
contract** — the interoperable surface a stranger can implement against. It deliberately
does **not** mandate how cleverly a runtime decides _when_ or _how_ to deliver; that is
implementation quality, not conformance (see §7).

> **Relationship to the internal specs.** The numbered docs in
> [`../specs/`](../specs/README.md) are this repository's _implementation contract_. This
> document is the _outward standard_ those internals aim to satisfy. Where they disagree,
> this standard describes the intended interoperable behavior and the internal specs
> describe what this codebase currently does.

---

## 1. The unit

A monitor is a folder containing a `MONITOR.md` file. Its **identity is the parent
directory name** — a stable machine identifier, not a frontmatter field.

- **Frontmatter** declares the _platform observation_: the mechanical question of which
  change to watch.
- **The Markdown body** declares the _semantic promotion_: what the change means for the
  reader and what the agent should do about it.

> Frontmatter is the event you would subscribe to. The body is the per-reader meaning that
> no central event bus can know on your behalf.

This split is also a boundary: **frontmatter states facts, the body states judgments.** A
conformant runtime reasons about neither — it observes the mechanical change the frontmatter
declares and delivers it with the body verbatim; all semantic judgment is the agent's, run
from the body. The format makes this structural: reasoning cannot leak into the runtime,
because the runtime only reads frontmatter, and frontmatter is config, not prose.

```yaml
---
name: Watch auth-module commits # optional; identity comes from the parent directory
watch:
  type: git-commits # the source type — an explicit, validated tag
  branch: main
  touches: 'src/auth/**'
---
New commits touched the auth code. Summarize what changed and whether it
affects what I am working on.
```

This is the minimal complete monitor: a `watch:` block and a body. No change filter, no
formatting, no urgency — every other field is optional with a sensible default, so the
simple case carries no knobs (see §7).

**Authoring is intent-first.** `watch.type` names a thing (`files`, `url`, `feed`,
`git-commits`, `webhook`, `schedule`, …), never a mechanism (`fingerprint`, `poll`); the
remaining keys in the `watch:` block are that type's configuration. This is deliberate: the
most common failure of mature event systems is "which event do I subscribe to for _my_
goal?" Declaring intent and letting the runtime map it to a mechanism removes that question.

**`type` is an explicit, validated tag — a discriminated union — never inferred from which
keys happen to be present.** The cost is one line; the return is precise validation errors,
a discoverable catalog of types, and the freedom for new types to share configuration keys
(two types may both take a `url:`) without the format becoming ambiguous.

## 2. The change vocabulary (`changeKind`)

Two tiers.

The **platform tier** is the stable, universal spine. Every conformant signal carries
exactly one of:

| `changeKind` | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `created`    | the object came into existence                                      |
| `modified`   | the observed object mutated                                         |
| `deleted`    | the object ceased to exist                                          |
| `appeared`   | a new member entered a watched collection/feed (optional predicate) |
| `elapsed`    | a time condition fired (no object change)                           |

> **This vocabulary is the standard's target, not necessarily this repository's current
> internal contract.** The internal specs (`../specs/`) presently use
> `created | modified | deleted | descoped`, where `created` / `descoped` are _scope
> transitions_ (an object entering or leaving a monitor's scope). This standard reframes the
> platform tier around observable change shapes and adds `appeared` and `elapsed`. The two
> are being reconciled; where they differ, treat the internal specs as the current
> implementation and this document as the intended direction. Do not assume the vocabularies
> match merely because the field name is shared.

The **semantic tier** (`action-item.detected`, `release.shipped`, …) is **not enumerated
by this standard**. Semantic meaning is manufactured per-monitor by the body instruction
together with the agent's judgment. The standard guarantees the platform spine; semantics
are authored at the edge, where the reader's intent lives.

## 3. The signal contract

The unit of delivery is a **self-contained observation: current state plus what changed** —
never a stream fragment that requires global ordering to interpret. An event log is a poor
state-reconstruction primitive; a conformant runtime does not ask the consumer to rebuild
state from a sequence of fragments.

```json
{
  "monitor": "payments-commits",
  "object": "git:src/payments/api.ts@a1b2c3",
  "changeKind": "appeared",
  "observedAt": "2026-06-07T18:04:11Z",
  "resumeToken": "<opaque, source-owned>",
  "state": {},
  "changed": {},
  "body": "...handling instruction (markdown)..."
}
```

The example is strict, copy-pasteable JSON. The fields split into two groups:

- **Stable spine (required, versioned conservatively):** `monitor` (the monitor id — the
  parent directory name), `object` (source-defined object identity), `changeKind` (§2),
  `observedAt` (the freshness timestamp — **mandatory**), and `resumeToken` (opaque,
  source-owned — §4).
- **Loose body (NOT lockstep-versioned):** `state` (the current observed state), `changed`
  (optional: how `state` differs from the prior observation), and `body` (the handling
  instruction, markdown). The example leaves `state` / `changed` empty because their shape
  is source-defined.

- **Stable thin spine + loose body.** The consumer is a language model, not a typed
  deserializer. Keep the spine small and stable for cross-host and cross-tool
  interoperability; let `state` / `body` be self-describing. Do **not** embed a separately
  versioned object schema that the consumer must deserialize in lockstep — that couples
  integration upgrades to payload shape and makes evolution brittle.
- **Freshness is explicit.** `observedAt` is required. A signal is timestamped evidence of
  a past moment, never asserted as present truth. For high-stakes reactions the body MAY
  instruct the agent to re-verify current state before acting — which it can, because it
  has tools.

## 4. Sources are resumable (durability & offline)

Every source persists a **resumption token** per object and reconciles on (re)connect. This
single mechanism underpins both restart-safety and survival across an offline window:

| Source archetype | Resumption token        | On (re)connect         |
| ---------------- | ----------------------- | ---------------------- |
| pull (file/url)  | content hash / snapshot | diff current vs. token |
| poll with cursor | cursor                  | fetch since cursor     |
| stream (ws/SSE)  | last event id           | replay from id         |

Reconnection always **dials outbound** — the device is never required to be internet
addressable. A relay is a _reachability shim_ used **only** for origins that cannot be
dialed (fire-and-forget webhooks); if an origin already exposes a stream, no relay is
involved. Redelivered or replayed signals **deduplicate by `object` identity**, so
at-least-once transport is safe.

## 5. Delivery: standardize the signal, not the transport

The same signal reaches the agent over whatever the host supports — a push channel,
surfacing on a host hook, or a CLI path.

- **Guaranteed:** the signal will reach the agent, durably, in the §3 shape.
- **Host-variable:** latency and presentation.

A conformant runtime MUST offer at least one non-push, non-managed-tool path (e.g. a host
hook or a CLI) so that monitors function in environments where managed-tool transports are
restricted.

## 6. Reliable reactions (opt-in)

By default a monitor is _fire-and-notify_ (informational; at-most-once delivery is
acceptable). A monitor becomes a **reliable reaction** by declaring a re-observable
post-condition:

```yaml
until: # presence promotes the monitor to the reliable tier
  watch:
    type: dependency
    name: lodash
  satisfied-when: 'version >= 4.17.21'
```

Then:

- An event opens a **durable reaction obligation** anchored to a session-timeline cursor.
- **Acknowledgment is revocable.** If the session rewinds or forks past the delivery point,
  the obligation reopens. (A normal event consumer is append-only and cannot un-acknowledge;
  an agent session can travel backward, so acknowledgment must be conditional on the timeline
  persisting.)
- The obligation **closes only when re-observation confirms the post-condition** — which
  makes reactions idempotent (check the desired end-state before acting) and survivable
  across rewind, compaction, and restart.
- **No host rewind signal is required.** Periodic re-checking of the post-condition
  eventually reconverges; an explicit rewind signal only makes reopening faster. Dumb hosts
  get eventual reliability; capable hosts get prompt reliability.

The guarantee is bounded by the **observability of the effect**: a reaction whose side
effect cannot be observed cannot be confirmed, and the runtime does not promise exactly-once
side effects. This is _deliver-and-verify_ rather than _deliver-and-hope_.

Only _imperative_ monitors (drive the world toward an end-state) have an observable
post-condition. _Informational_ monitors fall back to revocable acknowledgment ("delivered
and not rewound away").

## 7. Conformance, and the line between standard and implementation

| Level                      | A runtime must…                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **L0 — Author**            | parse `MONITOR.md`, derive identity from the parent directory, validate frontmatter.                            |
| **L1 — Observe & deliver** | evaluate a source into §3 signals with a valid spine and `observedAt`, and deliver over at least one transport. |
| **L2 — Reliable**          | honor §4 resumption and §6 reaction obligations.                                                                |

A minimal "fire the hook on every change" runtime is fully **L1-conformant**.

**Everything above is the open standard.** Below the line — _when_ to deliver
(debounce/throttle, lifecycle timing), deduplication and batching across signals,
cross-event synthesis ("what changed while you were away"), relevance pre-filtering — is
**implementation quality, not conformance**. The standard exists to make independent
runtimes interoperable; it deliberately does not mandate intelligence, so the
best-delivering runtime wins on merit rather than lock-in.

---

## Open questions (v0)

These are unresolved and invite proposals:

1. **Frontmatter key names.** The `watch:` block carrying an explicit `type` tag is locked
   (a discriminated union, not shape inference). The remaining key names — `when`, `deliver`,
   `until`, and each type's configuration keys — are still provisional. This surface _is_ the
   authoring experience and deserves careful design.
2. **Filters over `appeared`.** Narrowing "a new member of a collection matching a predicate"
   can live in `when:` (a change filter) or as per-type configuration inside `watch:` (e.g.
   `touches:`). Whether richer, source-agnostic filtering belongs in the standard as a
   first-class predicate, or stays entirely inside sources, is open.
3. **The post-condition language (§6).** Expressing a _re-observable_ predicate generically,
   without it growing into a full query language, is the deepest unsolved problem in the
   standard. `satisfied-when` as a string expression is a placeholder.
4. **Standardized vs. loose `state`.** The body is intentionally loose for model tolerance.
   The risk is that cross-host _tooling_ (as opposed to the agent) cannot reason about it.
   A small set of optional well-known fields may be warranted.
