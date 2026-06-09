---
title: The Monitor Standard
description: The open, host-agnostic MONITOR.md format specification — what a monitor is, the change vocabulary, and the signal contract.
---

# The Monitor Standard — `MONITOR.md`

> **Status:** Draft v0
> **Audience:** anyone implementing a runtime, a source, or a host adapter that produces or
> consumes monitor signals.

A **monitor** is a declarative, host-agnostic unit that turns a kind of external change
into a well-timed, actionable signal for an agent. You declare _what to watch_ and _what it
means for you_; a conformant runtime handles observation, change-detection, durability, and
delivery.

This document defines the **unit**, the **change vocabulary**, and the **signal contract** —
the interoperable surface a stranger can implement against.

---

## 1. The unit

A monitor is a folder containing a `MONITOR.md` file. Its **identity is the parent directory
name** — a stable machine identifier, not a frontmatter field.

- **Frontmatter** declares the _platform observation_: the mechanical question of which change
  to watch.
- **The Markdown body** declares the _semantic promotion_: what the change means for the
  reader and what the agent should do about it.

> Frontmatter is the event you would subscribe to. The body is the per-reader meaning that no
> central event bus can know on your behalf.

**Frontmatter states facts; the body states judgments.** A conformant runtime interprets only
the frontmatter (config) — it carries the body through to the agent verbatim, never acting on
it itself.

```yaml
---
name: Watch auth-module commits
watch:
  type: git-commits
  branch: main
  touches: 'src/auth/**'
---
New commits touched the auth code. Summarize what changed and whether it
affects what I am working on.
```

**`type` is an explicit, validated tag — a discriminated union — never inferred from which
keys happen to be present.** The cost is one line; the return is precise validation errors,
a discoverable catalog of types, and the freedom for new types to share configuration keys
without the format becoming ambiguous.

## 2. The change vocabulary (`changeKind`)

Two tiers.

The **platform tier** is the stable, universal spine. Every conformant signal carries exactly
one of:

| `changeKind` | Meaning |
|---|---|
| `created` | A new object entered the monitor's scope — first-time discovery or a new item |
| `modified` | The object changed while remaining in scope |
| `deleted` | The object was destroyed upstream; information is permanently lost |
| `descoped` | The object still exists upstream but left the monitor's scope; no information lost |

`deleted` and `descoped` are deliberately distinct: a `deleted` object is gone; a `descoped`
object merely moved out of the observed window.

The **semantic tier** (`action-item.detected`, `release.shipped`, …) is **not enumerated by
this standard**. Semantic meaning is manufactured per-monitor by the body instruction together
with the agent's judgment.

## 3. The signal contract

The unit of delivery is a **self-contained observation: current state plus what changed** —
never a stream fragment that requires global ordering to interpret.

```json
{
  "monitor": "payments-commits",
  "object": "git:src/payments/api.ts@a1b2c3",
  "changeKind": "modified",
  "observedAt": "2026-06-07T18:04:11Z",
  "resumeToken": "<opaque, source-owned>",
  "state": {},
  "changed": {},
  "body": "...handling instruction (markdown)..."
}
```

**Field groups:**

- **Stable spine (required, versioned conservatively):** `monitor`, `object`, `changeKind`,
  `observedAt` (mandatory freshness timestamp), `resumeToken` (opaque, source-owned)
- **Loose body (not lockstep-versioned):** `state` (current observed state), `changed`
  (optional diff from prior observation), `body` (handling instruction, markdown)

**Key properties:**
- `observedAt` is required. A signal is timestamped evidence of a past moment, never asserted
  as present truth.
- Keep the spine small and stable; let `state` / `body` be self-describing.
- The consumer is a language model, not a typed deserializer. Avoid separately versioned
  object schemas that create brittle upgrade coupling.

## 4. Sources are resumable (durability and offline)

Every source persists a **resumption token** per object and reconciles on (re)connect:

| Source archetype | Resumption token | On (re)connect |
|---|---|---|
| Pull (file/url) | Content hash / snapshot | Diff current vs. token |
| Poll with cursor | Cursor | Fetch since cursor |
| Stream (ws/SSE) | Last event id | Replay from id |

Reconnection always **dials outbound** — the device is never required to be internet
addressable. Redelivered signals **deduplicate by `object` identity**, so at-least-once
transport is safe.

## 5. Delivery: standardize the signal, not the transport

The same signal reaches the agent over whatever the host supports — a push channel, a host
hook, or a CLI path.

- **Guaranteed:** the signal will reach the agent, durably, in the §3 shape.
- **Host-variable:** latency and presentation.

A conformant runtime MUST offer at least one non-push, non-managed-tool path so monitors
function in environments where managed-tool transports are restricted.

## 6. Reliable reactions (opt-in)

By default a monitor is _fire-and-notify_. A monitor becomes a **reliable reaction** by
declaring a re-observable post-condition:

```yaml
until:
  watch:
    type: dependency
    name: lodash
  satisfied-when: 'version >= 4.17.21'
```

The obligation closes only when re-observation confirms the post-condition — making reactions
idempotent and survivable across rewind, compaction, and restart.

## 7. Conformance levels

| Level | A runtime must… |
|---|---|
| **L0 — Author** | Parse `MONITOR.md`, derive identity from the parent directory, validate frontmatter |
| **L1 — Observe & deliver** | Evaluate a source into §3 signals with a valid spine and `observedAt`, deliver over at least one transport |
| **L2 — Reliable** | Honor §4 resumption and §6 reaction obligations |

A minimal "fire the hook on every change" runtime is fully **L1-conformant**.

**Everything above is the open standard.** Below the line — _when_ to deliver
(debounce/throttle, lifecycle timing), deduplication and batching, cross-event synthesis,
relevance pre-filtering — is **implementation quality, not conformance**.

---

## Open questions (v0)

1. **Frontmatter key names.** The `watch:` block with an explicit `type` tag is locked. The
   remaining key names — `when`, `deliver`, `until`, and each type's config keys — are
   provisional.
2. **Filters over `appeared`.** Whether richer, source-agnostic filtering belongs in the
   standard as a first-class predicate, or stays inside sources, is open.
3. **The post-condition language (§6).** Expressing a re-observable predicate generically
   without it growing into a full query language is the deepest unsolved problem.
4. **Standardized vs. loose `state`.** A small set of optional well-known fields in `state`
   may be warranted for cross-host tooling.
