# 006 — Agent Integration & Delivery Transports

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md)
> **Covers:** the adapter seam, the delivery-transport abstraction, the hook-state transport
> (current), the Claude Code **channel** transport (target), workspace/session binding,
> cross-transport deduplication, the availability/fallback contract, and the **multi-host adapter
> matrix** (target, §11) — what a Codex or Cursor adapter must provide alongside the existing Claude
> Code adapter, and which parts of this document are Claude-specific vs host-generic

---

## 1. Overview

This document specifies how AgentMon surfaces its already-materialized deliveries into a host
agent's session, and how that surface can be served by more than one **transport**. The runtime
(see [002](./002-runtime-delivery.md)) decides _what_ is worth delivering and tracks its lifecycle
(unread/claimed/acknowledged). This document is about the _last hop_: getting a `DeliveryClaim`
in front of the agent.

### Why a transport abstraction?

Today there is exactly one delivery surface — a per-session `hook-state.json` consumed by Claude
Code hooks ([002 §8, §11](./002-runtime-delivery.md)). Claude Code's **channels** feature offers a
second, richer surface: an MCP server that pushes events straight into the session's context. The
two are not competitors; they are two **transports** for the same durable deliveries. Modeling them
behind one seam keeps delivery semantics identical regardless of which surface a given environment
can use (PP4, AP1, AP6).

### Principles satisfied

| Section                                 | Principles         |
| --------------------------------------- | ------------------ |
| Transport seam & contract               | PP4, AP1, AP3, AP6 |
| Hook-state transport (current)          | PP4, AP1, BP2      |
| Channel transport (target)              | PP4, BP2, NP-CH    |
| Availability & fallback                 | PP7, NP-CH         |
| Multi-host adapter matrix (§11, target) | PP4, AP3, AP6, NP5 |

> **NP-CH (non-property, this doc):** AgentMon does **not** require Claude Code channels. Channels
> are a research-preview, version-gated, org-gated MCP surface (see §5). A transport that may be
> unavailable in restricted environments **MUST** be additive, never a dependency.

## 2. The Transport Seam

The current seam is the `AgentRuntimeAdapter` (`libs/core/src/adapter/types.ts`), which today encodes
one transport: it maps lifecycle events to hook names (`hookEventMap`), derives a
`hook-state.json` path, and materializes hook state. Verified: `libs/core/src/adapter/claude.ts`
(`claudeCodeAdapter`).

A **delivery transport** is the generalization. Every transport **MUST**:

- consume the same `DeliveryClaim` / `DeliveryEventSummary` the runtime already produces
  (`libs/core/src/runtime/types.ts`); it **MUST NOT** re-derive what is worth delivering;
- preserve urgency and lifecycle semantics ([002 §9](./002-runtime-delivery.md)) — high surfaces at
  `turn-interruptible` after the settle window, normal/low coalesce;
- mark surfaced rows **claimed**, and **MUST NOT** acknowledge them (BP2). Acknowledgement remains a
  separate, explicit act (SP4);
- respect projection — only **lead** sessions receive deliveries
  ([002 §6](./002-runtime-delivery.md)).

> **Design note (realization).** The seam does **not** require an in-process `DeliveryTransport`
> abstraction. The hook-state behavior stays in the runtime + adapter, and the channel transport is
> realized **out-of-process**: an MCP server that consumes the daemon's existing IPC
> (`session.open`, `hook.claim`/`claimDelivery`, `events.ack`). So the transport boundary is the
> **daemon IPC surface** ([002 §10](./002-runtime-delivery.md)), not a new core type — a transport is
> anything that drives that IPC to surface `DeliveryClaim`s while honoring the rules above.

### 2.1 The Interpret adapter is upstream of transports, not a transport

> **Status: current** (G14, Refs #178). Marks the boundary an Interpret-stage AI-tool invocation
> crosses, now implemented behind the `InterpretAdapter` interface
> (`libs/core/src/adapter/interpret.ts`, concrete `createClaudeInterpretAdapter`). Formalizes
> the resolved decision from the monitoring capability study
> ([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
> §S4, resolved §S5 item 3; ledger row **C45**); the runtime contract is
> [002 §1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool).

The optional **Interpret** stage ([002 §1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool))
invokes the **user's own installed AI tool** (e.g. `claude -p …`) to produce the `prose`-form digest
and apply the agentic significance gate. That invocation is **host-specific** and **MUST** live behind
an adapter boundary, exactly as hook names live behind the `claudeCodeAdapter` — and **never** in the
runtime core (the host-agnostic-core invariant, [002 §11.1](./002-runtime-delivery.md#111-the-agentruntimeadapter-contract),
AP3).

Crucially, this is **not** a delivery transport. A delivery transport (§2 above) **surfaces** an
already-produced `DeliveryClaim` into a session and **MUST NOT** re-derive what is worth delivering;
the Interpret adapter sits **upstream** of that — it helps **produce** the packet's `prose` content
(and may suppress it) **before** any transport surfaces it. The two boundaries do not overlap:
Interpret runs after Diff and before Deliver ([002 §1.1.1](./002-runtime-delivery.md#111-the-locked-stage-order));
a transport runs at Deliver. Because Agent Monitors **ships no model and holds no credentials**, the
Interpret adapter inherits the user's existing data-governance and egress posture by construction —
the same trust principle stated in [002 §1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool).

Verified: `libs/core/src/adapter/interpret.ts` — the `InterpretAdapter` interface and the concrete
`createClaudeInterpretAdapter` shell-out; `libs/core/src/runtime/service.ts` — `runInterpret` invokes
the adapter upstream of any transport (after Diff, before Deliver), never re-derived at Deliver.

## 3. Hook-State Transport (Current)

The hook-state transport is the portable default and is fully specified in
[002 §8 (Hook State)](./002-runtime-delivery.md) and [002 §11 (Adapters)](./002-runtime-delivery.md).
Summary of its contract here: per-session `hook-state.json` is refreshed each tick; Claude Code hooks
read it at lifecycle points and surface reminders/claims. It binds at **session** granularity
(keyed by `(adapter, hostSessionId)`), so its unread/claimed accounting is exact per session.

This transport has **no external availability requirement** beyond the host's hook mechanism and is
the baseline every environment can use.

## 4. Channel Transport (Target)

> **Status: implemented.** The one-way push (§4.1), the two-way `agentmon_ack` tool (§4.3), and
> plugin packaging (the channel MCP now ships inside the `agentmonitors` activation plugin at
> [`agent-plugins/agentmonitors/.mcp.json`](../../agent-plugins/agentmonitors/.mcp.json) — a
> `.mcp.json` that runs `agentmonitors channel serve`, alongside the lifecycle hooks; see §5.6) all
> ship. `DeliveryEventSummary` now also carries `body` (the raw
> monitor instructions — see [002 §9.1](./002-runtime-delivery.md)), available to transports that
> want to surface the body alongside the title/summary. Remaining is an end-to-end **manual UAT**
> (channels are research-preview, so not CI-able) and optional fuller meta (§4.2 `object_key`). The
> UAT recipe lives at [`docs/uat/channel-transport.md`](../uat/channel-transport.md) — run it before
> treating this transport as regression-safe, and record the run there.
> See [roadmap.md](./roadmap.md) (G7, shipped).

A channel is an MCP server Claude Code spawns over stdio that pushes events into the session as
`<channel …>` tags. AgentMon ships a channel server that bridges the daemon's deliveries onto that
surface. (Channel mechanism reference:
<https://code.claude.com/docs/en/channels-reference.md>.)

### 4.1 Mechanism

> **Status: implemented** as the `agentmonitors channel serve` command
> (`apps/cli/src/commands/channel.ts`, [005 §13](./005-cli-reference.md)). It resolves its session
> via `CLAUDE_CODE_SESSION_ID` (§4.4), polls `claimDelivery('turn-interruptible')` over the daemon
> socket, and pushes each returned claim. (The two-way ack tool is §4.3; packaging is the
> `agentmonitors` activation plugin — §5.6.)

The AgentMon channel server:

- declares the channel capability: `capabilities.experimental['claude/channel'] = {}`;
- connects to the AgentMon daemon over its existing Unix-socket IPC
  ([002 §10](./002-runtime-delivery.md)) — it is a thin MCP front-end over the same surface that
  `hook claim` / `events` already use, not new core logic;
- surfaces each settled `DeliveryClaim` with **reserve → commit/release**
  semantics (§4.5.1), so a rejected or disconnected push never permanently
  consumes the delivery;
- resolves that socket with a precedence deliberately **different** from
  `resolveManualDaemonSocketPath` (issue #335, used by the manually-typed `session`/`events`/`hook`/
  `daemon` commands): an explicit `--socket` still wins outright, but an **enabled** workspace's
  persisted-or-derived per-workspace socket now wins over `AGENTMONITORS_SOCKET` — not just over the
  bare global default (issue #358) — because `channel serve` is spawned automatically (like a hook,
  with no flags) and a stale env var left over from a different workspace must never cross-connect
  it to that other workspace's daemon (a session-isolation break) or a dead socket. Only a
  not-enabled workspace falls back to `AGENTMONITORS_SOCKET`, then the global default. This mirrors
  the isolation guarantee `hook deliver` already enforces (§5.0/[005 §12](./005-cli-reference.md))
  by refusing to fall back past an enabled workspace's own socket;
- pushes each settled `DeliveryClaim` for its bound session as a `notifications/claude/channel`
  event.

### 4.2 Notification field schema

The runtime's existing `DeliveryClaim` renders into the channel notification's two params. Field
conventions follow the bundled reference channels (snake_case identifier keys, string-only values,
multi-values flattened):

- **`content`** (string): the rendered delivery — see the content contract in §4.2.1. AgentMon
  authored/observed text is **untrusted** (see §4.6).
- **`meta`** (`Record<string,string>`): routing/context attributes. Keys **MUST** be identifiers
  (`[A-Za-z0-9_]`); hyphens are silently dropped by the host, so kebab fields are converted:

  | meta key      | value                                                 | notes                                                                                                                 |
  | ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
  | `monitor_id`  | the monitor's ID                                      | single-event claims only                                                                                              |
  | `urgency`     | `low` \| `normal` \| `high`                           |                                                                                                                       |
  | `object_key`  | the event `objectKey`                                 | sanitized (§4.6)                                                                                                      |
  | `event_id`    | the durable event ID                                  | passed back by the ack tool (§4.3); single-event claims only                                                          |
  | `event_count` | number of pending events, stringified                 | coalesced events for a body-injection claim; the session's **unread total** for a reminder claim (§4.2.1) — never `0` |
  | `lifecycle`   | `turn-interruptible` \| `turn-idle` \| `post-compact` |                                                                                                                       |

The `source` attribute on the rendered `<channel>` tag is set by the host from the MCP server name
(e.g. `agentmonitors`), not by `meta`.

> **Stage-1 coverage.** The one-way server renders from a `DeliveryClaim`, whose
> `DeliveryEventSummary` carries `eventId`, `monitorId`, `urgency`, `body` (the raw monitor
> instructions), `diffText` (the change summary; optional), etc. but **not** `objectKey`. So stage 1
> emits `lifecycle`, `mode`, `event_count`, `urgency`, and (for a single event) `monitor_id` and
> `event_id`. `object_key` is target and requires further enrichment; it is not yet emitted.

#### 4.2.1 `content` rendering contract

> **Status: implemented.** `apps/cli/src/channel-render.ts`, sharing the per-event block builder
> `apps/cli/src/delivery-event-render.ts` with the hook-deliver transport (§5.1).

The channel is a **rendering surface over the same semantics** as the hook-deliver transport — "same
events, same urgency … only the surface" (§6). The tag body therefore carries the **same event
content the hook path injects**, not a lesser summary. Two claim shapes render differently:

- **Body-injection claim** (a settled high-urgency delivery, or a `post-compact` recap — `events` is
  populated): `content` renders **one block per event**, joined by a blank line. Each block is the
  transport-shared per-event block:

  ```text
  ### <monitor_id> (<urgency>)
  <title>

  <body — the monitor author's instructions for this event>

  Changes:
  <bounded diffText — the change summary>
  ```

  The `Changes:` section appears only when the event carries a non-empty `diffText`. The change
  summary is **bounded** per event (currently 800 chars) with an explicit elision marker
  (`… (change summary truncated)`) — a raw diff can be arbitrarily large and the tag body lands in
  the agent's context window (§4.6). This is exactly the block the hook-deliver transport renders
  into `additionalContext` (§5.1); the only per-transport difference is content sanitization (the
  channel strips `<>[]` for tag safety, §4.6; the hook path preserves them) and the ceiling each
  applies (the hook path bounds a single turn's `additionalContext` at 4000 chars; the channel packs
  WHOLE blocks under its own, much larger content ceiling — §5.5 below).

- **Reminder claim** (`normal`/`low` — no event bodies, only a coalesced advisory `message`):
  `content` renders that generic message as-is, aside from the same tag-safety sanitization applied
  above — this shape needs no packing (a coalesced message is already small), same as the
  body-injection claim (002 §9.2) — with **no** body injection.

`renderChannelEvent` renders **every event in the `DeliveryClaim` it is given**, in the common case —
it never drops a WHOLE block to fit a cap. The channel surface IS bounded (§5.5), but primarily by
packing WHOLE event blocks under a content ceiling **before reserving**, not by cutting an
already-claimed render: `channel serve` previews the settled high-urgency delivery, sizes how many
whole blocks fit
(`packChannelEventsUnderCap`, `apps/cli/src/channel-render.ts`), and reserves/claims exactly that many
(`reserveDelivery`'s `maxEvents`) — mirroring exactly how the hook-deliver transport sizes its
`additionalContext` cap (§5.1, issue #299). This is what makes boundedness compatible with §5.5's
**claimed-set-equals-rendered-set** invariant: capping the assembled `content` **after the claim was
already reserved** would have dropped later blocks from the rendered tag while the whole claim was
still eligible to be committed, silently omitting claimed-but-unrendered events — rendering (the
push) always runs before the commit that marks rows claimed, never the reverse (§5.5). Any
settled-high events that do not fit stay pending and
re-deliver on a later poll, with an explicit, bracket-free deferral marker appended to `content` (never
`<`/`>`/`[`/`]`, so it needs no `contentValue` sanitization pass of its own). Only the **per-event**
change summary is bounded independently of packing (above, and §4.6), so no single untrusted diff is
dumped wholesale regardless of how many events fit.

**Exception: a single reserved (not yet committed) event whose own block alone still exceeds the
ceiling.** Sizing upstream cannot rule out this pathological case — `packChannelEventsUnderCap`
deliberately returns at least 1 for a non-empty preview (forward progress, §5.5), and a reserve can
race the earlier preview so the actually-reserved event was never measured. Only in this one case
does `renderChannelEvent` cut an already-reserved (not yet durably claimed) block: it mid-truncates
the lone event at a Unicode code-point boundary and appends a
DIFFERENT marker than the deferral marker above, because — unlike the deferred-remainder case, where
the whole block stayed unclaimed and genuinely re-delivers later — this render happens BEFORE the
reservation is committed, so at render time it is genuinely unknown which of THREE outcomes the commit
that follows will land on (issue #442, PR #442 round-12 review — collapsing these to two conflates a
definite outcome with a genuinely uncertain one): a commit that **resolves non-null** means the row is
claimed and will **never** re-deliver on a later ordinary poll; a commit that **resolves null** (the
reservation's lease already lapsed, `'surfaced-uncommitted'`) means the row was definitely never
claimed and stays eligible for at-least-once redelivery; a commit that **rejects** (an IPC/transport
error) is neither of those — the daemon may have applied it before the response was lost, so whether
the row ends up claimed or still pending is genuinely UNCERTAIN, not a guaranteed redelivery (§5.5 has
the full mechanics and the reason the two markers must differ, and why the marker itself stays
outcome-neutral across all three cases). That marker names the exact, session- and socket-scoped
`agentmonitors events list --session <id> --socket <path> --unread` command (the socket path
transport-safe-escaped, issue #442, PR #442 round-8 review — see §5.5) as the recovery path that holds
regardless of that outcome, for the full, still-unread event — never the bare `--unread` form (`events
list` requires `--session`, §5).

**Mixed case: the oversized single event AND a genuinely deferred remainder (issue #442, PR #442
round-12 review).** `moreDeferred` can be true in the SAME render as the mid-truncation exception above
— the claim's one (oversized) event is the only one actually reserved, but additional, distinct
settled-high work exists beyond it and stays genuinely pending. The two facts do not overlap (this
event's own cut tail vs. a separate deferred event) and neither implies the other, so `renderChannelEvent`
appends BOTH markers — the truncation marker above AND the deferral marker — sized together within
`MAX_CHANNEL_CONTENT`; appending only the truncation marker would silently drop the "more work is
pending" signal and violate this section's candidate-growth guarantee. This mirrors the hook-deliver
transport's `renderHookDelivery`, which renders both of its analogous markers in the identical mixed
case (§5.5).

A body-injection claim that rendered only its **title** — dropping the monitor body and the change
summary — is a **defect on this surface**, not a lighter rendering: the receiving agent would have to
already know what the monitor meant and separately run `events list` to see what changed, defeating
push delivery.

### 4.3 Two-way: acknowledgement tool

> **Status: implemented.** `agentmonitors channel serve` declares `capabilities.tools` and exposes
> the `agentmon_ack` tool (`apps/cli/src/channel-ack.ts`), routing it through `events.ack`. Arguments
> are validated defensively at the MCP boundary (`parseAckArgs`).

To close the unread→acknowledged loop in-session, the channel server **MAY** be two-way
(`capabilities.tools = {}`) and expose an acknowledgement tool, e.g.:

```jsonc
{
  "name": "agentmon_ack",
  "description": "Acknowledge AgentMon events surfaced in this workspace",
  "inputSchema": {
    "type": "object",
    "properties": {
      "event_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Event IDs from the <channel event_id=...> tags. Omit to ack all unread.",
      },
    },
  },
}
```

The handler routes through the daemon's existing `events ack` IPC path. Following the reference
channels' "outbound gate" pattern, the server **MUST** re-authorize that each `event_id` belongs to
the bound session/workspace before acking. (Permission relay is **out of scope** — see §6.)

### 4.4 Workspace/session binding

Both identity signals a channel server needs are available to a process **spawned as an MCP server**.
The two **workspace** signals are **documented**; the **session-id** signal is **empirically observed
but undocumented**, so it is treated as observed behavior backed by a documented fallback:

- **`CLAUDE_PROJECT_DIR`** (documented) — set to the workspace path, and the server's cwd is the same
  path. <https://code.claude.com/docs/en/mcp.md>: "Claude Code sets `CLAUDE_PROJECT_DIR` in the
  spawned server's environment to the project root."
- **`roots/list`** (documented) — answered, returning the workspace as a single `file://` root (same
  reference: "Your server can also call the MCP `roots/list` request, which returns the directory
  Claude Code was launched from").
- **`CLAUDE_CODE_SESSION_ID`** (undocumented; empirically present) — inherited by the MCP-server
  subprocess and equal to the host session id (note the variable is `CLAUDE_CODE_SESSION_ID`, **not**
  `CLAUDE_SESSION_ID`). The current MCP reference documents only the two workspace signals above; it
  does **not** list `CLAUDE_CODE_SESSION_ID`. Its presence is confirmed empirically by the
  `experiments/channel-probe` run (Claude Code 2.1.157; see [roadmap.md](./roadmap.md) G7) and
  **re-confirmed against Claude Code 2.1.160** — in a live session the variable is present in
  MCP/child-process environments and its value exactly equals the live session id. Because this is
  observed-not-contracted, the workspace-binding fallback below is the robustness hedge if a future
  host stops setting it.

> **Contrast with hooks — different transport, different mechanism (and a real trap).** A Claude Code
> **hook** does **not** read its session id from `CLAUDE_CODE_SESSION_ID`: per
> <https://code.claude.com/docs/en/hooks.md> a hook receives `session_id` in its **stdin payload**,
> and the documented hook environment variables are `CLAUDE_PROJECT_DIR` / `CLAUDE_PLUGIN_ROOT` /
> `CLAUDE_PLUGIN_DATA` / `CLAUDE_EFFORT` / `CLAUDE_ENV_FILE` / `CLAUDE_CODE_REMOTE` — the session id is
> **not** among them. That is why the hook-deliver transport (§5.0) reads `session_id` from stdin
> while the channel server reads `CLAUDE_CODE_SESSION_ID` from its environment: a hook is a short-lived
> per-event command whose session context arrives as the event payload, whereas the channel server is
> a long-lived MCP subprocess with no per-event stdin (its stdin is the JSON-RPC channel), so it
> relies on the inherited process environment. Both resolve the **same** host session id; do not
> "unify" them onto one mechanism — each uses the channel its runtime actually provides.

Binding strategy, in preference order:

1. **Session binding (preferred — confirmed available):** read `CLAUDE_CODE_SESSION_ID` and bind
   directly to that host session. Unread/claimed accounting is then exact, matching the hook-state
   transport's precision, and the multi-lead ambiguity below does not arise. The channel server
   **MUST** confirm this id corresponds to a tracked AgentMon session — i.e. the same value the
   `SessionStart` hook passed to `session open --host-session-id …` (the runtime opens the session;
   the channel transport only attaches to it).
2. **Workspace binding (fallback):** if `CLAUDE_CODE_SESSION_ID` is absent (e.g. a future host that
   does not set it), read `CLAUDE_PROJECT_DIR` (or `roots/list`) for the workspace `W` and surface
   the lead session(s) projected for `W` ([002 §6](./002-runtime-delivery.md)).

**Single-lead-session assumption (workspace-binding fallback only).** When `W` has exactly one active
lead session (the common case), workspace binding is equivalent to session binding and unread/claimed
accounting is exact. When `W` has multiple concurrent lead sessions, the channel server **MUST**
degrade rather than guess: it surfaces the workspace's unread but **MUST NOT** claim on behalf of an
ambiguous session; the per-session hook-state transport (§3) remains the accurate surface in that
case. The runtime can detect the multi-lead condition because it tracks all sessions. Session
binding (1) avoids this case entirely, which is why it is preferred.

### 4.5 Cross-transport deduplication

Both transports key off the same `session_event_state`. When the channel transport surfaces a
delivery it marks the underlying rows **claimed** (BP2), so the hook-state transport sees them
already claimed and suppresses the duplicate reminder. No new dedup mechanism is required — the
existing claimed state ([002 §7](./002-runtime-delivery.md)) is the dedup boundary across transports.

While a channel push is **in flight** — reserved but not yet committed (§4.5.1) — its rows are
**leased**: hidden from the hook transport's claim decision exactly as a claimed row would be, so the
two transports still cannot double-surface the same event during the push window. A lease is neither
a claim nor an acknowledgement; committing the reservation is what durably marks the rows claimed.

### 4.5.1 Transport-state semantics: reserve → commit / release

> **Status: implemented** (issue #300). Verified: the core `reserveDelivery` / `commitDelivery` /
> `releaseDelivery` methods (`libs/core/src/runtime/service.ts`, backed by the in-memory
> `DeliveryReservationRegistry`), their `hook.reserve` / `hook.commit` / `hook.release` daemon IPC
> methods, the channel's `runChannelDeliveryCycle` (`apps/cli/src/commands/channel.ts`), and the tests
> in `libs/core/src/runtime/delivery-reservations.test.ts` and `apps/cli/src/commands/cli.integration.test.ts`
> ("channel reserve → commit/release delivery cycle").

A transport that surfaces claims over a **fallible** channel (the channel MCP push can reject or the
transport can disconnect) **MUST NOT** mark a delivery claimed **before** it has actually surfaced it
— a claim timestamp (`first_notified_at`) means "**was surfaced**". Marking claimed first means a
transient push failure permanently consumes the delivery: the rows stay claimed, and the hook
transport suppresses them as cross-transport duplicates (§4.5) even though nothing ever surfaced them
(a P1 delivery-loss violation of the additive/fallback guarantee, §6/NP-CH).

The channel therefore surfaces each claim in three steps, per poll:

1. **Reserve** (`reserveDelivery` → `hook.reserve`): compute and render the same `DeliveryClaim` a
   direct claim would, and **lease** its rows (§4.5) — but perform **no** durable state change. The
   rows stay `unread` and **unclaimed**.
2. **Push** the claim as the `notifications/claude/channel` event.
3. On a **successful** push, **commit** (`commitDelivery` → `hook.commit`): now mark the reserved rows
   claimed ("was surfaced", BP2 — still **not** acknowledged, SP4). On a **failed / disconnected**
   push, **release** (`releaseDelivery` → `hook.release`): drop the lease so the rows return to
   `pending`, where the hook transport (or the next poll) re-delivers them.

Guarantees this establishes (issue #300):

- **No claim before surfacing.** `first_notified_at` is written only at commit, so a claim timestamp
  is always truthful ("was surfaced").
- **Failed pushes fall back.** A released (or self-expired) reservation leaves the rows `pending`, so
  a transient MCP disconnect costs at most one poll — the hook transport delivers durably regardless
  (§6/§6.1), and the next channel poll retries.
- **Successful sends stay deduplicated only once the commit resolves non-null.** The lease (during
  the push) hides the rows from the hook transport for the in-flight window, but that hiding becomes
  a durable claim only after `commitDelivery` resolves **non-null**; a **null** resolution means the
  reservation's lease had already lapsed and the rows were never marked claimed at all (see below).
- **Rows stay unacknowledged throughout.** Neither reserve, commit, nor release acknowledges;
  acknowledgement remains the separate, explicit `agentmon_ack` / `events ack` act (§4.3, SP4).
- **At-least-once, never at-most-once — three distinct commit outcomes, not two.** After a
  successful push, `commitDelivery`'s outcome is one of three, and they are **not**
  interchangeable:
  1. **Resolves non-null** — the commit landed; the rows are now claimed ("was surfaced").
  2. **Resolves null** — the reservation's lease had already lapsed (a slow/hung push, or a daemon
     restart that dropped the in-memory lease) before the commit could apply; the rows are
     **definitely** still `pending` and re-deliver via the hook path or the next poll.
  3. **Rejects** — an IPC/transport error on the commit call itself. Whether the daemon applied the
     commit before the response was lost is **genuinely uncertain**: the rows may be claimed, or may
     still be `pending`. The transport MUST treat this case as distinct from (2), never assuming
     "uncommitted" — it reports the uncertainty rather than asserting either state.
     Cases (2) and (3) both mean the transport **MUST NOT** treat the push as a successful claim, but
     only case (2) is a **known** re-deliverable-pending state; case (3) is a possible **duplicate**
     surface in that rare window, never a **lost** delivery (the safe direction, PP1).

While a reservation is in flight, the **diagnostic and hook-state projections are lease-aware too**:
the `hook deliver --debug` diagnosis (§5.2.1) and the per-session hook-state file
([002 §8](./002-runtime-delivery.md)) exclude leased rows from "pending claimable work", so they never
advertise a row the reservation makes momentarily unclaimable — staying consistent with what a claim
would decide. Reserving and releasing refresh the hook-state projection so it tracks the lease as it
is taken and dropped. (Leased rows remain **unread** — a lease is not an acknowledgement — so recap
and `events list --unread` still show them.)

The reservation registry is **in-memory and daemon-local**: both transports drive the one daemon
runtime (§6.1), and losing a lease (daemon restart, or a crashed/hung reserve that never commits or
releases) is the **safe** direction — the rows simply return to `pending` for the hook path (PP1).
A reservation self-expires after a short ceiling so a holder that neither commits nor releases cannot
hide rows from the hook transport indefinitely.

### 4.6 Content safety

Channel `content` is injected directly into the agent's context, and AgentMon event content can carry
text from watched sources (API bodies, file diffs) that AgentMon does not control. Therefore, for any
transport that injects content:

- `meta` string values **MUST** be sanitized against tag-breakout characters (strip
  `/[<>\[\]\r\n;]/`, matching the reference channels' `safeName`/`safeAttName`);
- surfaced `content` **SHOULD** be bounded/summarized rather than dumping full untrusted bodies;
- identity/routing references (`object_key`, paths) belong in `meta`, never interpolated into
  `content`, because `content` is attacker-influenceable.

This concern is not new to channels — the hook-state path surfaces the same content — but channels
make injection more direct, so it is stated here as a transport-level requirement.

## 5. Hook-Deliver Transport (Current — Plan D)

> **Status: implemented.** `agentmonitors hook deliver` (`apps/cli/src/commands/hook.ts`).

The **hook-deliver transport** is a CLI command designed to run directly inside a Claude Code
lifecycle hook. When invoked it reads the hook payload from **stdin**, claims any pending deliveries
for the session, and emits them as **advisory, non-blocking `additionalContext`** injected into the
agent at the turn boundary — the same format any hook can use to surface information without blocking
the tool call.

Because only some events honor `additionalContext` (see §5.4), the command derives the delivery
lifecycle from the firing event and **emits nothing** for events that would ignore the context. The
hook config is therefore the same single command line for every event: `agentmonitors hook deliver`.
The default output remains the Claude Code hook wire JSON; `--format json` selects that same wire
shape explicitly, while `--format text` prints only the rendered `additionalContext` for manual
inspection.

This transport is fully self-contained (no MCP server, no channel capability requirement) and works
in any environment that can run Claude Code hooks.

### 5.0 Input contract (stdin JSON)

Claude Code delivers hook input as a **JSON object on stdin**, not as environment variables. There
is **no `CLAUDE_CODE_SESSION_ID` environment variable** in a hook invocation — relying on one would
silently no-op in real sessions. The command reads all of stdin, parses it as JSON, and uses:

| Payload field     | Used for                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `session_id`      | the host session id, matched against tracked AgentMon sessions (no env fallback) |
| `hook_event_name` | the firing event, mapped to a delivery lifecycle (§5.4) and echoed in the output |
| `cwd`             | the workspace path (then `CLAUDE_PROJECT_DIR`, then the process cwd)             |

The read is robust: if stdin is a TTY or empty/unparseable, the payload is treated as `{}` (the
command never hangs waiting for input). The only relevant documented hook environment variable is
`CLAUDE_PROJECT_DIR`, used as a workspace fallback when the payload omits `cwd`.

This stdin contract is shared by **all hook-invoked commands** — `hook deliver` **and** the lifecycle
commands `session start` / `session end` (§5.6). All three derive the host session id from
`session_id` and the workspace from `cwd` → `CLAUDE_PROJECT_DIR` → process cwd; none of them read a
session id from the environment.

> **Input contract reference:** <https://code.claude.com/docs/en/hooks.md> (Hook Input — "Hooks
> receive data via stdin as JSON" with `session_id`, `cwd`, `hook_event_name`, `transcript_path`,
> `permission_mode`, plus event-specific fields).

### 5.1 Wire Contract

The hook reads its payload from stdin (§5.0), then prints a JSON object to stdout in the
default/json format and **MUST exit 0**. Non-zero exit or a missing `continue` field causes Claude
Code to ignore hook output, so installed hook commands use the default/json wire format. The wire
shape:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "<EventName>",
    "additionalContext": "<rendered text>"
  }
}
```

- **`continue: true`** — advisory delivery never blocks the agent (BP2).
- **`hookEventName`** — echoes the event that fired the hook (e.g. `"PostToolUse"`,
  `"UserPromptSubmit"`). Taken from the stdin payload's `hook_event_name`; it must match the firing
  event or the host ignores the `additionalContext`.
- **`additionalContext`** — the rendered delivery: a lead line followed by one block per event
  with the monitor id, urgency, title, and the monitor's **body-instructions** (`DeliveryEventSummary.body`).
  Capped at 4000 characters. Unlike the channel transport (§4.6), this is a plain JSON string
  (`JSON.stringify` escapes it) and is **not** tag-delimited, so `<`, `>`, `[`, `]`, `;`, and
  newlines are preserved verbatim — a monitor body is trusted, user-authored markdown that
  legitimately contains code and links. Only raw C0/C1 control characters (except tab/newline) are
  stripped. **Truncation:** when the assembled context exceeds the 4000-char cap, it is truncated at
  a Unicode **code-point** boundary (never splitting a surrogate pair, which would corrupt the JSON)
  and an explicit marker is appended — but **which** marker depends on whether the omitted content
  genuinely re-delivers, mirroring the channel transport's split (§4.2.1) and detailed fully in §5.5:

  ```text
  [truncated — more monitor updates are pending; run `agentmonitors events list --session <id> --socket <path> --unread` to see the rest]
  ```

  is used when a WHOLE event block was left unclaimed (still pending — it genuinely re-delivers at
  the next context event), while

  ```text
  [truncated — this update was too large to show in full; the full copy stays unread — run `agentmonitors events list --session <id> --socket <path> --unread` to see it now]
  ```

  is used when THIS claim's own content was cut (a single event's own block exceeds the cap, or a
  truncated reminder message). This marker is rendered from the **reservation's own claim, before
  that reservation is committed** (§5.2, issue #442, PR #442 round-9/10 review) — so it deliberately
  does **not** assert whether the row ends up durably claimed, or whether it will or will not
  redeliver: at render time it is genuinely unknown which of THREE outcomes the commit that follows
  will land on (issue #442, PR #442 round-12 review — collapsing these to two conflates a definite
  outcome with a genuinely uncertain one). A prior version of this marker asserted "it is claimed but
  NOT acknowledged ... it will not redeliver automatically" — true only if the commit **resolves
  non-null**; **false** if it **resolves null** (the rows are then definitely never claimed and
  deliberately stay pending, so they **will** redeliver via the ordinary context-event flow); and
  neither holds if the commit **rejects** (an IPC/transport error), since the daemon may have applied
  it before the response was lost, making the row's eventual claimed/pending state genuinely
  UNCERTAIN rather than a guaranteed redelivery — fixed to state only what holds regardless of which
  of the three outcomes occurs: the full copy is not yet acknowledged, so it stays unread and
  reachable right now via the recovery command (issue #442, PR #442 round-10/12 review). Both markers
  may appear together in the same `additionalContext` (issue
  #442, PR #442 round-8 review): when the sole claimed event is itself oversized (the second
  marker's case) AND further, different high-urgency work also stays genuinely pending beyond it
  (the first marker's case), both are rendered — they describe two non-overlapping facts and
  neither implies the other.

  `agentmonitors events list` **requires** `--session <id>` (§5, issue #420 P2) — a bare
  `agentmonitors events list --unread` exits 1 — so each marker renders the exact, directly runnable
  command for the session that received THIS delivery, with the claim's own (sanitized) `sessionId`
  substituted in, not the bare form (issue #442). Each marker also carries an explicit `--socket
<path>` (issue #358, PR #442 round-7 review): `agentmonitors events list` resolves its own socket
  **env-first**, so a copy-pasted command with no `--socket` could silently query a stale
  `$AGENTMONITORS_SOCKET` left over from a different workspace rather than the daemon `hook deliver`
  actually resolved and claimed against. The socket path is rendered via the transport-shared
  `escapeShellPath` (`delivery-event-render.ts`, issue #442, PR #442 round-8 review) — the SAME
  helper the channel transport's `content` uses (§4.2.1) — so it is both shell-safe (spaces, quotes)
  and round-trips to the exact original path when the advertised command is run in `bash`/`zsh`. The
  final string including whichever marker(s) apply is still ≤ 4000 chars. Truncation never drops a
  durable event: see §5.5 (unread-recoverability).

- **No `permissionDecision` field** — advisory; the agent decides what to do.

When there is nothing pending, the command **MUST** print nothing and exit 0 in every format — an
empty stdout is the signal to Claude Code to proceed silently.

### 5.2 Behavior

1. Read all of stdin and parse it as a JSON hook payload (§5.0). A TTY/empty/unparseable stream → `{}`.
2. `sessionId = payload.session_id`. If absent → exit 0, print nothing (not a tracked Claude session).
   There is **no** env-var fallback.
3. Derive the lifecycle from `payload.hook_event_name` (§5.4) unless `--lifecycle` is explicitly
   passed. If the event is not a context event (no mapping) → exit 0, print nothing.
4. Read `.claude/agentmonitors.local.md` via `readLocalState(payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd)`.
   If `!enabled` or no socket → exit 0, print nothing.
5. Resolve the socket path via `resolveSocketPath` (flag → `.local.md` socket). Require an explicit
   per-workspace socket — do **not** fall back to the global default (that could cross workspaces).
   If the daemon is unreachable → exit 0, print nothing.
6. Call `listSessionsClient(socket)`, find the session whose `hostSessionId` matches `sessionId`. If
   not found → exit 0, print nothing **on stdout**; ALSO write one line to **stderr**,
   unconditionally (regardless of `--debug`), naming the unresolved id (issue #329) — see the exact
   wording and rationale in §5.2.1.
7. **Reserve, re-validate (fit AND candidate-growth), RENDER, WRITE, then commit**
   (`reserveSizedHookDelivery` + `reserveRenderAndCommitHookDelivery` +
   `writeAndCommitHookDelivery`, issue #442, PR #442 rounds 8–9) — not a single direct
   `claimDeliveryClient(sessionId, lifecycle, socket, maxEvents)` call, and — critically — the durable
   commit is now the LAST step, never the first. For a `turn-interruptible` claim, sizing
   (`previewSettledHighDeliveryClient` + `packEventsUnderCap`) and the reservation itself are two
   SEPARATE IPC round-trips, so the events the reservation actually returns can differ from the ones
   the preview measured (a concurrent caller substitutes different, larger pending events into the
   same requested count). Claiming directly on an unvalidated count would let a substituted, oversized
   set pass the count check but still fail `renderHookDelivery`'s own repack — and because a claim
   marks the underlying rows claimed **synchronously**, the truncated-away tail of an already-claimed
   row can never redeliver (§5.5). `reserveSizedHookDelivery` therefore **reserves** (leases, does not
   yet claim), then re-validates the fit of the **actual** reserved claim via `resolveHookClaimFit` —
   the same predicate `renderHookDelivery` uses — releasing and retrying with a tighter cap on a
   mismatch (bounded; the final attempt forces a single-event reservation, which always terminates).
   It ALSO re-validates `moreDeferred` itself against a post-reservation preview (the candidate-set-
   growth race, mirroring the channel transport's `settledWorkRemainsBeyondClaim` — issue #442, PR
   #442 round-9 review), releasing the reservation before propagating a re-preview failure. Once fit is
   confirmed, `renderHookDelivery` renders the RESERVATION's own claim (never a committed one) into
   `output`; the command writes that `output` to stdout FIRST, and only commits
   (`commitDeliveryClient`) AFTER the write has succeeded — see the at-most-once-loss rationale below.
   The write itself is awaited through `writeStreamChunk`'s completion callback (or the stream's own
   `'error'` event, whichever fires first) — **never** `stdout.write`'s synchronous return value, which
   signals backpressure (whether the internal buffer is full), not success: a write can return `true`
   immediately and still fail asynchronously afterward (e.g. `EPIPE` once Claude Code's hook consumer
   has already closed its end of the pipe), which would otherwise reopen the same at-most-once loss
   window this ordering fix closes (issue #442, PR #442 round-10 review). A write failure — synchronous
   OR the awaited async rejection — releases the reservation instead of committing (nothing durably
   claimed; the rows return to pending). Non-`turn-interruptible` lifecycles, and a reminder claim
   (`events: []`), carry no per-event sizing risk and are reserved+committed unsized (recap
   re-validation of `moreDeferred` never applies — see step 8); a reminder claim's `moreDeferred` is
   also always reported `false` regardless of what the settled-high sizing preview computed before the
   preview↔reserve race fell back to it (mirroring the channel transport's identical fix, issue #442,
   PR #442 round-10 review) — `renderHookDelivery` never reads `moreDeferred` for an eventless claim,
   but `--debug`'s cap-deferral diagnostic does, and a stale preview-derived value would otherwise
   report a spurious cap deferral for a claim with no cap-truncated events at all. If reservation
   returns nothing pending, or the commit itself returns `null` (the reservation's lease expired before
   commit, or the daemon restarted) → exit 0. In the lease-expired case the output — if any — was
   ALREADY written by this point, so this
   is a safe, intentional duplicate rather than a loss.
8. Render (as part of step 7, using the reservation's own claim, BEFORE commit) via
   `renderHookDelivery(claim, hookEventName)`. If null (no event bodies and no reminder message),
   nothing is written and the reservation still commits unsized (there is nothing to lose by
   committing an empty render). Marker selection inside `renderHookDelivery` is **lifecycle-aware**
   (issue #442, PR #442 round-9 review): a `post-compact` recap renders a distinct, lifecycle-specific
   marker rather than either of the ordinary turn-interruptible markers — see §5.5's recap-marker
   paragraph.
9. Write output (if any) and exit 0. The omitted/default format and `--format json` write compact hook
   wire JSON via `JSON.stringify(output)`. `--format text` writes only
   `output.hookSpecificOutput.additionalContext`. The commit (step 7) happens strictly AFTER this
   write succeeds.

**Why commit must be the LAST step, not the first (issue #442, PR #442 round-9 review — an
at-most-once loss window).** The pre-round-9 flow committed the reservation — the durable
`first_notified_at` mutation that permanently excludes these rows from ordinary redelivery — BEFORE
any hook output was rendered or written to stdout. If the daemon applied the commit but its RPC
response was lost, or if rendering/writing failed AFTER commit, the command's always-exit-0 try/catch
(below) swallowed the error and emitted nothing — while the rows were durably excluded from
redelivery forever, recoverable only via the durable-but-unread `agentmonitors events list` copy. By
rendering off the reservation's own (not-yet-committed) claim and deferring commit until after a
successful write, a write failure can instead be recovered by RELEASING the reservation (nothing
durably claimed, rows stay pending), and a commit failure/uncertainty AFTER a successful write only
risks a later DUPLICATE delivery — the safe direction, never a silent loss. This mirrors the channel
transport's reserve → push → commit ordering (§4, issue #300), applied to the hook transport's
synchronous stdout write instead of a fallible MCP push.

**Any internal error MUST be swallowed.** The command is invoked by a Claude Code hook; an
unhandled error would interrupt the user's session. The wrapping try/catch ensures the command
always exits 0 regardless of IPC failures, missing state, or unexpected errors.

### 5.2.1 `--debug` diagnosis (issue #334) and the always-on unknown-session warning (issue #329)

Every quiet-return step in §5.2 (steps 2–8) is, by design, indistinguishable **on stdout** from the
outside: an unknown `session_id`, a disabled workspace, an unreachable daemon, and genuinely "nothing
pending" all produce identical empty stdout + exit 0. That silence is the correct **stdout** contract
(§5.1) — a real hook invocation must never inject diagnostic noise into the agent's context — but
without a diagnostic it leaves the operator with no way to tell "correctly idle" from "misconfigured"
(blind DX study S3 F3).

**One branch is the exception (issue #329): step 6's unresolved `session_id`.** Every other
quiet-return branch is diagnosable only via `--debug`, opt-in, because each one either resolves
itself (the ~15s high-urgency claim-settle window, §9.1 of [002](./002-runtime-delivery.md)) or
reflects a genuinely idle state that is not worth warning about by default. An unresolvable
`session_id` is different: it can **never** resolve on its own, and its silent empty output was
reported as indistinguishable from the legitimate settle window — an operator would poll forever
against a session that will never deliver. So step 6 ALWAYS writes one line to stderr, regardless of
`--debug`:

```text
hook deliver: no session registered for host session id "<id>"
```

Stdout and the exit code are completely unaffected — only stderr gains this one line. Because
`session_id` is untrusted stdin input, `<id>` is rendered control-safe and bounded: it is
JSON-string-escaped (embedded quotes, newlines, and all other control characters appear as escape
sequences, never raw — including DEL, the C1 controls U+0080–U+009F, and the U+2028/U+2029
line/paragraph separators, which plain `JSON.stringify` would pass through) and truncated at 128
characters — cut at a Unicode code-point boundary — with a trailing `…`, so the warning is always
exactly one line of bounded length. Every other
quiet-return branch (disabled workspace, unreachable daemon, settle-window hold, nothing pending,
…) remains silent by default; diagnose those with `--debug` below.

`--debug` writes a parallel diagnosis to **stderr only**, one line per step of §5.2, naming which
branch was hit and, once a session is resolved, the unread (unacknowledged) counts by urgency and a per-band
hold reason for anything not yet deliverable:

- `settle-window` — pending high-urgency work exists but is not yet past the 15s claim-time settle
  window (§9.1 of [002](./002-runtime-delivery.md)).
- `already-claimed` / `coalesced-until-ack` — the coalesced normal/low reminder ([002 §9.2/§9.3](./002-runtime-delivery.md))
  is currently suppressed. This is the SAME vocabulary `monitor explain`'s reminder-suppression
  diagnosis uses ([002 §10.7](./002-runtime-delivery.md), issue #333) — both surfaces explain the
  identical coalescing guard and MUST agree on what to call it.
- `deferred-by-cap` — settled high-urgency events existed but some were deferred by the transport's
  own 4000-char cap (§5.5); a hold reason owned by this transport, not the runtime.

**Criterion: stdout MUST be byte-identical between a `--debug` run and a non-`--debug` run of the
same payload against the same daemon state.** `--debug` adds exactly one extra read-only daemon call
(the diagnosis query, `hook.diagnose`) before the existing claim; it never claims, suppresses, or
mutates state itself, and every diagnosis write targets `process.stderr`, never `process.stdout`. An
internal error is still swallowed on stdout (the always-exit-0 contract is unchanged); `--debug`
additionally names it on stderr instead of disappearing silently.

Every untrusted stdin field a `--debug` line interpolates — `session_id`, `hook_event_name`, and `cwd`
(including the workspace path derived from it) — gets the SAME control-safe rendering as the always-on
warning above (issue #365): JSON-string-escaped (DEL, the C1 controls, and U+2028/U+2029 included) and
truncated at 128 characters — cut at a Unicode code-point boundary — with a trailing `…`. `--debug` is
opt-in, but that must not make it acceptable to leak a hostile payload to the operator's terminal/logs
raw — both paths share one rendering function so they cannot drift.

See [005 §12.2.1](./005-cli-reference.md) for the exact line-by-line diagnosis contract.

### 5.3 Usage

The same single command line is registered on every event AgentMon cares about — the command derives
the lifecycle from the firing event and stays silent on events it should not inject into (§5.4).
Register it only on **context events** (the events that honor `additionalContext`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "agentmonitors hook deliver" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "agentmonitors hook deliver" }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "agentmonitors hook deliver" }
        ]
      }
    ]
  }
}
```

`--lifecycle` remains available as an **optional override** (primarily for tests); when omitted, the
lifecycle is derived from the event per §5.4. `--format text` is available for manual inspection but
is not used by hook registration because Claude Code expects the default/json wire object.

### 5.4 Event → lifecycle mapping & `additionalContext` support

`hookSpecificOutput.additionalContext` is honored only by **context events**: `UserPromptSubmit`,
`SessionStart`, and `PostToolUse`. It is **not** honored by `PreToolUse` (which uses
`permissionDecision`) or `Stop` (which uses a top-level `decision`). Emitting `additionalContext` on
a non-context event is useless — the host ignores it — so the command maps only context events to a
lifecycle and emits nothing otherwise.

> **Reference:** <https://code.claude.com/docs/en/hooks.md> — JSON Output Format → "Context events
> (SessionStart, PostToolUse): use `hookSpecificOutput.additionalContext`"; and the hooks guide:
> "For `UserPromptSubmit` hooks, use `additionalContext` to inject text."

| Hook event         | Honors `additionalContext`? | Derived `lifecycle`  | What is surfaced                                                                          |
| ------------------ | --------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `UserPromptSubmit` | yes                         | `turn-interruptible` | Settled high-urgency events (≥15 s old); normal as reminder (low surfaces at `turn-idle`) |
| `PostToolUse`      | yes                         | `turn-interruptible` | Settled high-urgency events (≥15 s old); normal as reminder (low surfaces at `turn-idle`) |
| `SessionStart`     | yes                         | `post-compact`       | All unread events as a recap with bodies                                                  |
| `PreToolUse`       | **no** (permissionDecision) | — (emit nothing)     | nothing — additionalContext would be ignored                                              |
| `Stop`             | **no** (top-level decision) | — (emit nothing)     | nothing — additionalContext would be ignored                                              |

Note: for `turn-interruptible`, `normal` urgency (and `low` at `turn-idle`) returns `events: []`
(reminder text only, no body injection). The body is surfaced only for **high-urgency settled
events** and **post-compact recap**. "Reminder text only" is **not** silence: `hook deliver` renders
the claim's advisory `message` (the same line `hook claim` surfaces), sanitized and length-capped,
into `hookSpecificOutput.additionalContext`, so a default (`normal`-urgency) monitor produces a visible
mid-turn reminder — just without the per-event body block. The underlying rows are claimed but **not**
acknowledged (BP2 / SP4 — see §5.5), so the event stays unread and re-discoverable via
`agentmonitors events list --unread`. `renderHookDelivery` returns `null` (the command prints
nothing) only when the claim is `null` or carries neither events nor a reminder message.

### 5.5 Unread-recoverability & cap-bounded redelivery (truncation never loses an event)

A length-bounded transport (the hook-deliver 4000-char `additionalContext`, §5.1) may be unable to
surface every settled high-urgency event in a single context injection. The delivery guarantee is
that the events it cannot show **re-deliver at the next context event**, in order, until every item
has surfaced — never silently lost.

**The claimed set MUST equal the rendered set.** A transport **MUST NOT** claim an event it does not
surface. Concretely, the hook-deliver transport:

1. **previews** the settled high-urgency delivery without mutating state
   (`previewSettledHighDelivery` returns exactly the set a `turn-interruptible` claim would surface,
   in delivery order, applying the same per-recipient `net` collapse decision but persisting nothing);
2. **sizes** how many **whole** event blocks fit under the cap (never a partial block, which would be
   a claimed-but-unread event with no clean re-delivery boundary), reserving room for the truncation
   marker;
3. **reserves** (leases, does not yet claim) with that count as `maxEvents`, then **re-validates the
   fit of the ACTUAL reserved claim** — not the sizing preview, which is a separate IPC round-trip and
   can already be stale by the time the reservation lands (issue #442, PR #442 round-8 review;
   `resolveHookClaimFit`, the same predicate `renderHookDelivery` itself uses). A mismatch releases the
   reservation (the rows return to `pending` — nothing was ever claimed, so nothing is lost) and
   retries with a tighter cap, exactly mirroring the channel transport's
   `reserveSizedChannelDelivery`/`resolveChannelClaimFit` below;
4. **re-validates `moreDeferred` itself** against a post-reservation preview (the candidate-set-growth
   race — issue #442, PR #442 round-9 review, mirroring the channel transport's
   `settledWorkRemainsBeyondClaim` below): a settled event that arrives strictly BETWEEN the sizing
   preview and the reservation is invisible to that preview's `moreDeferred`, yet the reservation it
   produced can still, on its own, fit and need no resizing — `moreDeferred` must still flip `true` so
   the render signposts the newly-settled remainder. If `moreDeferred` flips, the fit is re-checked
   against the final, marker-reserving budget, releasing and retrying (with the just-measured cap) if
   it no longer fits. A failure of this revalidation preview itself releases the reservation before
   propagating; then
5. **renders** the reservation's own (not-yet-committed) claim via `renderHookDelivery`, **writes** the
   result to stdout, and only THEN **commits** the reservation (`commitDeliveryClient`) — never the
   reverse (issue #442, PR #442 round-9 review; see the at-most-once-loss rationale in §5.2). A write
   failure releases the reservation instead of committing. Once committed, the deferred remainder is
   left **pending** (`first_notified_at` NULL) and re-delivers at the next context event.

This reserve → validate-fit → commit sequence exists specifically to close a substitution race a
direct sized claim (`claimDelivery(sessionId, lifecycle, maxEvents)`, the pre-#442-round-8
implementation) could not: preview and claim are two separate IPC round-trips, so a concurrent caller
could substitute different, larger pending events into the same requested COUNT — passing the count
check but still overflowing the cap. Because a claim marks the underlying rows claimed
**synchronously**, an event dropped from a mismatched claim's render could never redeliver. Reserving
first (leasing, not claiming) makes the mismatch check-and-retry safe: nothing is durably consumed
until the fit is confirmed.

Because committing marks the underlying rows **claimed**, which is **not** acknowledgement (BP2 / SP4;
`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), every event — surfaced or
deferred — also **remains unread** and listable via `agentmonitors events list --unread` until
explicitly acknowledged.

The deferred-remainder truncation marker (§5.1) is appended whenever the render omits any pending
event — because a whole block did not fit **or** because the transport deferred more high-urgency
work — signposting that more updates are pending. The single pathological case where one event's own
block alone exceeds the cap is shown partially (mid-truncated at a code-point boundary) to guarantee
forward progress. **This case's own tail does not (ordinarily) re-deliver the way the
deferred-remainder case does**, but the marker used here (§5.1) deliberately does NOT assert that
outcome, or the claim's durable state, one way or the other: rendering happens BEFORE the reservation
is committed (§5.2, issue #442, PR #442 round-9/10 review), so at render time it is genuinely unknown
which of THREE outcomes the commit that follows will land on (issue #442, PR #442 round-12 review —
collapsing these to two conflates a definite outcome with a genuinely uncertain one). If the commit
**resolves non-null**, the row is claimed and this event's own omitted tail will not surface again
via the ordinary context-event flow; if it **resolves null** (the reservation's lease already
lapsed), the row was definitely never claimed, so the rows deliberately stay **pending** and WILL
redeliver normally — the opposite outcome; if it **rejects** (an IPC/transport error), neither
holds — the daemon may have applied the commit before the response was lost, so whether the row
ends up claimed or still pending is genuinely UNCERTAIN, not a guaranteed redelivery. A prior version
of this marker asserted the redeliver-will-not-happen outcome unconditionally ("it is claimed but NOT
acknowledged ... it will not redeliver automatically"), which was simply false whenever the commit
resolved null (issue #442, PR #442 round-10 review). The fixed wording
states only what is true regardless of outcome: the full body is not yet acknowledged, so it stays
unread and is recoverable right now via `agentmonitors events list --session <id> --unread` (issue
#442, PR #442 rounds 7 and 10). **The two markers can co-occur (issue #442, PR #442 round-8
review):** when the sole reserved event is itself this pathological oversized case AND further,
different high-urgency work also stays genuinely pending beyond it (`moreDeferred`),
`renderHookDelivery` renders BOTH markers together — they describe two non-overlapping facts (this
event's own tail vs. a separate, still-pending remainder) and neither implies the other, so omitting
either one would silently drop a real signal.

The non-high branches need no sizing: `normal`/`low` reminders inject no per-event bodies, and the
`post-compact` recap re-shows all unread each time, so both self-heal.

**The channel transport (§4.2.1) applies the SAME reserve → validate-fit → commit pattern, against its
own, much larger content ceiling.** It is not exempt from boundedness — a coalesced high-urgency push previewed,
sized, and rendered without limit would make a single `notifications/claude/channel` payload
unbounded — but unlike the hook path it is not sizing to a single turn's context budget, so its
ceiling is deliberately generous. `channel serve` previews the settled-high delivery
(`previewSettledHighDeliveryClient`), sizes whole blocks via `packChannelEventsUnderCap`
(`apps/cli/src/channel-render.ts`), and passes the result as `reserveDelivery`'s `maxEvents` before
reserving — the identical pattern §5.5 describes above for the hook path, differing only in the block
joiner (`\n\n`, no fixed header) and the deferral marker (bracket-free, since the channel sanitizes
`<>[]` out of `content`, §4.6). A reminder claim (no settled-high events) needs no sizing and omits
`maxEvents`, claiming the full claim exactly as before.

**A settled event that arrives strictly BETWEEN the sizing preview and the reservation (a
"candidate-set growth" race, issue #442, PR #442 round-6 review) must still surface the deferral
marker.** Preview and reserve are two separate IPC round-trips (as above), so the candidate set can
grow, not just shrink or substitute: the preview held exactly one event (so `maxEvents = 1`,
`moreDeferred = false`), a second event settles before `reserveDelivery` runs, and the resulting
one-event claim genuinely fits — nothing needs re-sizing or releasing. But that second, now-settled
event is real pending work the render must still signpost; treating the claim as "fits, nothing
deferred" would silently omit it. `reserveSizedChannelDelivery` re-runs the same read-only settled-high
preview once more, AFTER a reservation is accepted, and compares it against the claimed event ids —
any settled event not in the claim forces `moreDeferred: true` before the result is returned to
`channel.ts`.

**The single-event pathological case's marker differs from the deferred-remainder marker, because
rendering — and therefore this mid-truncation — happens BEFORE the reservation is committed (issue
#442, PR #442 round-11 review).** For the channel's reserve → push → commit cycle
(`runChannelDeliveryCycle`), `renderChannelEvent` mid-truncates a lone event whose own block still
exceeds the ceiling as PART OF the push itself; the commit that sets `first_notified_at` only runs
AFTER that push resolves. So at render time it is genuinely unknown which of THREE outcomes the commit
that follows will land on (issue #442, PR #442 round-12 review — collapsing these to two conflates a
definite outcome with a genuinely uncertain one):

- **Resolves non-null** — committed: `pendingEventsForSession()` (whose query requires
  `first_notified_at` still `NULL`, 002 §7) will never return the row again, so the omitted tail does
  **not** "re-deliver at the next poll" the way the deferred-remainder case does.
- **Resolves null** — the reservation's lease already lapsed (`'surfaced-uncommitted'`): the row was
  definitely never claimed and stays eligible for at-least-once redelivery on a later poll — the
  opposite outcome from the bullet above.
- **Rejects** (an IPC/transport error) — this is NOT the same as resolving null: the daemon may have
  applied the commit before its response was lost, so whether the row ends up claimed or still pending
  cannot be determined from the rejection alone. Treating a rejection as a guaranteed redelivery would
  be as wrong as treating it as a guaranteed commit.

Either way — regardless of which of the three outcomes actually occurs — the durable, still-unread
copy of the full event is the recovery path that holds (claiming ≠ acking, BP2 / SP4), which is the
only thing the marker itself asserts. `agentmonitors events list` **requires** `--session <id>` (§5,
issue #420 P2) — a bare
`agentmonitors events list --unread` exits 1, so the marker must render the exact, directly runnable
command for the session that received THIS delivery, not the bare form (issue #442, PR #442 round-6
review). It must also carry an explicit `--socket <path>` (issue #358, PR #442 round-7 review):
`events list` itself resolves its socket ENV-FIRST (`resolveManualDaemonSocketPath`, issue #335), so a
copy-pasted command with no `--socket` could silently query a stale `$AGENTMONITORS_SOCKET` left over
from a different workspace rather than the daemon `channel serve` is actually bound to.
`channel-render.ts` therefore signposts this case with a distinct marker, built by
`buildChannelTruncatedMarker(sessionId, socketPath)`, reading ``(this update was too large to show in
full; run `agentmonitors events list --session <id> --socket <path> --unread` to see the full
copy)`` — deliberately outcome-neutral, asserting only that the full copy stays unread and reachable
right now, never a specific claimed/redelivery outcome — with the claim's own (sanitized) `sessionId`
and the resolved `socketPath` substituted in. The socket path is rendered via the transport-shared
`escapeShellPath` (`delivery-event-render.ts`, issue #442, PR #442 round-8 review) — NOT a plain
POSIX single-quote (the prior approach): a single-quoted path preserves every byte literally,
including `<`/`>`/`[`/`]`, and this marker is appended into `content` AFTER `contentValue`'s own
tag-safety sanitization pass has already run, so a socket path carrying those bytes would otherwise
reintroduce them raw into the pushed `<channel>` body (006 §4.6). `escapeShellPath` instead renders
the path in bash/zsh ANSI-C quoting (`$'...'`), hex-escaping (`\xNN`) every byte outside a
conservative safe set — no forbidden byte can then appear in the tag body, while the path still
reconstructs exactly when the advertised command is run — reserving `CHANNEL_DEFERRED_MARKER`'s
"surface on a later poll" language for the case where a whole block genuinely stayed unclaimed and
pending.

**Mixed case: both markers together (issue #442, PR #442 round-12 review).** The single-event
pathological case above and the deferred-remainder case are not mutually exclusive: `moreDeferred` can
be true in the SAME render where the lone claimed event also had to be mid-truncated (its own block
exceeded the ceiling). The two facts describe different, non-overlapping events — this claim's own
truncated tail vs. a separate, genuinely-pending event beyond the claim — so `renderChannelEvent`
appends BOTH the truncation marker and `CHANNEL_DEFERRED_MARKER`, sized together within
`MAX_CHANNEL_CONTENT`. Appending only the truncation marker in this case would silently drop the
"more work is pending" signal, contradicting this section's candidate-growth guarantee. This mirrors
`renderHookDelivery`'s identical handling (below): when its analogous mixed case occurs, it renders
both `buildHookClaimedUnreadMarker` and `buildHookDeferredMarker` together rather than picking one.

**The hook-deliver transport ALSO uses two distinct, session- and socket-scoped markers, mirroring
the channel side (issue #442, PR #442 round-7 review), and (since round-8) reserves/commits through
the SAME two-phase sequence the channel side does (§5.5 above) rather than a single direct claim.**
Unlike round-8, the render (and its markers) now runs BEFORE `commitDelivery` marks the rows claimed
(sets `first_notified_at`) — see §5.2's render-before-commit ordering (issue #442, PR #442 round-9
review). `renderHookDelivery` receives the RESERVATION's own claim, still uncommitted at that point —
and, since round-10, its marker language no longer asserts the row's eventual claimed or redelivery
state at all, since that outcome is genuinely one of three distinct possibilities until the commit
that follows the write settles: it **resolves non-null** (the rows are now claimed), **resolves
null** (the lease had already lapsed — the rows are definitely still pending), or **rejects** (an
IPC/transport error whose effect on the rows is genuinely uncertain, not the same as a null
resolution). BOTH the single-event mid-truncation branch AND a truncated reminder message
describe THIS claim's own content being cut, not other pending work being deferred — that much is
known at render time regardless of the pending commit's outcome. Only the deferred-remainder branch
(a whole block genuinely left OUT of the render, still pending — never reserved at all) legitimately
promises a later redelivery, since those rows were never part of this reservation to begin with.
`hook-deliver-render.ts` therefore builds two markers from the SAME two inputs the channel side uses:
`buildHookDeferredMarker(sessionId, socketPath)` — "more monitor updates are pending", used only for
the genuinely-deferred-remainder branch — and `buildHookClaimedUnreadMarker(sessionId, socketPath)` —
used for the single-event mid-truncation branch and for a truncated reminder message, reading "this
update was too large to show in full; the full copy stays unread — run `agentmonitors events list
--session <id> --socket <path> --unread` to see it now". This wording states only what holds
regardless of whether the pending commit lands: the full copy is not yet acknowledged, so it stays
unread and reachable right now via the recovery command. A prior version of this marker asserted "it
is claimed but NOT acknowledged ... it will not redeliver automatically" — true only if the commit
**resolves non-null**; false if it **resolves null** (the reservation's lease already lapsed), since
the rows then are definitely never claimed and deliberately stay pending, so they DO redeliver via
the ordinary context-event flow; and neither holds if the commit **rejects** (an IPC/transport
error), since the daemon may have applied it before the response was lost, leaving the row's eventual
claimed/pending state genuinely UNCERTAIN rather than a guaranteed redelivery (issue #442, PR #442
round-10/12 review). Before the
round-7 split, both branches shared one marker whose "more monitor updates are pending" framing
falsely implied the mid-truncated event's own omitted tail would also redeliver.

**The two markers are NOT mutually exclusive (issue #442, PR #442 round-8 review).** When the sole
reserved event is itself the pathological mid-truncation case AND further, different high-urgency work
also stays genuinely pending beyond it (`moreDeferred`), `renderHookDelivery` renders BOTH markers in
the same `additionalContext` — the claimed-unread marker's outcome-agnostic "the full copy stays
unread" framing describes only THIS event's own omitted tail, and does not (and must not) speak for
the separate, genuinely-pending remainder, which the deferred marker signposts correctly.

**Marker selection is lifecycle-aware: a `post-compact` recap needs its own, THIRD framing, distinct
from both markers above (issue #442, PR #442 round-9 review).** `decideDelivery`'s `post-compact`
branch (`service.ts`) reads `unreadEventsForSession` — NOT `pendingEventsForSession` — and
`applyDelivery` claims the FULL candidate set (every unread event, not just the rendered
`recapSlice`) at commit time regardless of what actually renders. Because recap re-sources from
UNREAD state, a row being claimed (`first_notified_at` set) never hides it from a FUTURE recap; only
acknowledging does — and that self-heal guarantee holds regardless of whether THIS particular recap's
own commit lands, since a future recap always re-sources from `unreadEventsForSession` again. That
makes BOTH ordinary markers insufficient for a recap: `buildHookDeferredMarker`'s "more monitor
updates are pending ... run `events list --unread` to see the rest" wrongly implies the omitted whole
blocks are not (about to be) claimed along with the rest of the recap's candidate set;
`buildHookClaimedUnreadMarker`'s outcome-agnostic "the full copy stays unread" is accurate but
incomplete for a recap — it misses the stronger, POSITIVE guarantee a recap actually offers: the
omitted/cut content WILL reappear, automatically, on the NEXT `post-compact` recap (and any after
that) until acknowledged, which is the intentional self-heal behavior this section already documents.
`renderHookDelivery` therefore checks `claim.lifecycle === 'post-compact'` and, when true, uses a
single unified `buildHookRecapMarker` in place of BOTH ordinary markers (for the whole-blocks-omitted
branch AND the single-event mid-truncation branch alike — for a recap both are the SAME fact: content
that stays unread and will keep re-surfacing on future recaps), reading "not everything fit in this
recap; the omitted content stays unread and will reappear on future recaps until acknowledged — run
`agentmonitors events list --session <id> --socket <path> --unread` to see it now". Like the ordinary
claimed-unread marker, this recap marker is also built from the reservation's own claim before commit
— so it deliberately asserts only the self-healing future-recap behavior (true regardless of this
particular commit's outcome), never that this content specifically "is claimed" right now.

No durable event is lost by truncation; the cap only bounds how much is injected into a single turn (or,
for the channel, into a single push).

### 5.6 Activation packaging (the `agentmonitors` plugin)

> **Status: implemented.** Activation ships as a **colocated [aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli)
> marketplace** embedded in this repo: the single `agentmonitors` plugin under
> [`agent-plugins/`](../../agent-plugins/) is installed once into Claude Code, after which a project
> opts in with project-local state (no plugin reinstall per monitor). Generated marketplace
> registries (`.claude-plugin/marketplace.json`) are committed and freshness-checked by
> `aipm validate` in CI.

The plugin wires the host lifecycle to the already-built CLI verbs (the user installs the
`agentmonitors` bin globally — e.g. `npm i -g @agentmonitors/cli`):

| Hook event         | Command(s)                    | Purpose                                                                                                                                                                                                                             |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | `agentmonitors session start` | Lazy-boot the per-workspace daemon + register the session, then surface the post-compact recap **in the same process** (a no-op when nothing is pending). NOT a chained `&& hook deliver` — see "single-process SessionStart" below |
| `UserPromptSubmit` | `agentmonitors hook deliver`  | Primary turn-boundary delivery (`turn-interruptible` per §5.4)                                                                                                                                                                      |
| `SessionEnd`       | `agentmonitors session end`   | Deregister the session so the idle daemon reaps itself                                                                                                                                                                              |

`hook deliver` reads the hook payload from **stdin** and derives the firing event from
`hook_event_name` (§5.0/§5.4) — it takes no `--hook-event-name` flag. `session start`/`session end`
read the **same stdin payload** (§5.0): the host session id is the payload's `session_id` (there is
**no `CLAUDE_CODE_SESSION_ID` env var** — reading one would silently no-op in a real session, so the
daemon would never boot and the session would never register), and the workspace is `cwd` →
`CLAUDE_PROJECT_DIR` → process cwd. They take no `--host-session-id` flag. `PreToolUse`/`Stop` are intentionally **not** wired
(they ignore `additionalContext` — §5.4); `PostToolUse` is left as a documented future tunable (it
fires per-tool, so a daemon round-trip per tool is too costly for v1). Because the aipm v0.3.0 Claude
hooks transform only covers `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`, the lifecycle
events (`SessionStart`/`SessionEnd`) are authored as a host-native
[`hooks/hooks.json`](../../agent-plugins/agentmonitors/hooks/hooks.json), rather than via aipm's
YAML→JSON hook generation. Claude Code **auto-discovers** the conventional `hooks/hooks.json` path;
the plugin manifest must **not** also reference it (a `hooks` manifest entry may only name
_additional_ hook files — a reference resolving to the auto-discovered file is rejected at plugin
load as a duplicate hooks file, failing the install).

**Hardened command form.** The hook commands are not bare `agentmonitors …` invocations; each is
shell-guarded for the "installed plugin, missing CLI" case (a user who hasn't yet run
`npm i -g @agentmonitors/cli`, or whose PATH differs in the hook environment):

- **CLI-absent guard (all hooks).** Each command is wrapped `command -v agentmonitors >/dev/null 2>&1
&& … || true`, so an uninstalled CLI produces a silent exit 0 rather than a `command not found`
  (exit 127) surfaced to the user on every prompt in every project. The `SessionStart` hook goes
  further and turns the miss into onboarding: when the CLI is absent it emits a one-shot
  `additionalContext` hint pointing at `npm i -g @agentmonitors/cli`.
- **Monitors-found-but-disabled advisory (`SessionStart`, issue #269).** `session start`'s
  quick-exit for a project that has not opted in ([002 §10.2](./002-runtime-delivery.md) "Lazy
  boot") used to be **fully silent** in every case — including when the project already has
  monitor definitions under `.claude/monitors/` and the user simply never flipped `enabled: true`.
  That combination is the worst onboarding dead-end: monitors sit unobserved and nothing ever says
  why. `session start` now scans `.claude/monitors` (via the same `scanMonitors()` the `scan`/
  `validate` commands use) before quick-exiting on a disabled project. If it finds **zero**
  definitions, behavior is unchanged — a user who never opted in at all is never nagged, and the
  command exits 0 with no stdout. If it finds **one or more** (counting both files that parsed
  successfully and files that failed to parse — a malformed monitor is still evidence the user
  tried), it emits a single `additionalContext` advisory stating that monitoring is disabled, how
  many monitor definitions were found, the exact enable step (create
  `.claude/agentmonitors.local.md` with `enabled: true`), and a pointer to `agentmonitors doctor`
  for the full workspace-health picture (issue #331) — then still exits 0 **without** opening a
  session or booting a daemon (this scan-and-advise step never auto-enables the project or starts
  the runtime; it is advisory only, same as the CLI-absent hint above). Rendered by
  `renderMonitoringDisabledAdvisory()` (`apps/cli/src/hook-deliver-render.ts`), called from
  `apps/cli/src/commands/session.ts`'s `!state.enabled` branch.
- **Single-process `SessionStart` (one stdin stream).** A Claude Code hook invocation provides
  **one** stdin stream for the whole command. Both `session start` and `hook deliver` read the hook
  payload with `readHookPayload()` (which consumes all of stdin), so a chained
  `agentmonitors session start && agentmonitors hook deliver` is broken: `session start` consumes the
  payload, and the subsequent `hook deliver` sees EOF, parses `{}`, finds no `session_id`, and
  silently no-ops — killing the recap. Therefore `agentmonitors session start` reads the payload
  **once** and, after registering, performs the post-compact recap **itself** — reserving,
  rendering, writing (awaited to completion), and only then committing the `post-compact`
  reservation via the SAME shared `reserveRenderAndCommitHookDelivery` / `writeAndCommitHookDelivery`
  flow `hook deliver` uses (§5.2, issue #442, PR #442 round-16 review), printing the rendered
  `additionalContext` when there are unread events. This closes the same at-most-once loss window
  §5.2 describes for `hook deliver`'s own commit ordering: committing the reservation BEFORE the
  recap was successfully written would durably claim the unread rows even if an asynchronous write
  failure (e.g. `EPIPE`) meant nothing ever reached the agent. The SessionStart hook runs the single
  command `agentmonitors session start`; there is no chained delivery. (This also avoids the
  parallel-execution race a two-entry form would have had.) The `UserPromptSubmit` and `SessionEnd`
  hooks are each their own invocation with their own stdin, so they remain single commands.

The channel MCP (§4) ships in the same plugin via
[`.mcp.json`](../../agent-plugins/agentmonitors/.mcp.json) (server key `agentmonitors`, preserving
the `<channel source="agentmonitors">` tag). A bundled `setup-monitors` skill walks the user through
enabling a project (the gitignored `.claude/agentmonitors.local.md` with `enabled: true`) and carries
plain-language monitoring intent through source selection, minimal config elicitation,
`.claude/monitors/<id>/MONITOR.md` authoring, `agentmonitors validate`, mandatory firing
verification, and `monitor explain`-based debugging.

## 6. Availability & Fallback

The channel transport is **optional and additive**. It depends on conditions a restricted environment
may deny:

- Claude Code **v2.1.80+**, channels in **research preview**;
- on Team/Enterprise, an admin must enable channels (`channelsEnabled`), and custom channels must be
  on the org's allowlist (or launched with the development flag);
- the broader class of MCP-server restrictions common in enterprise.

Accordingly (NP-CH):

- the **hook-state transport (§3) is always the default** and never depends on channels;
- enabling the channel transport **MUST NOT** change delivery semantics — same events, same urgency,
  same unread/claimed/acknowledged model — only the surface;
- if the channel is not loaded or is blocked, its notifications are dropped silently by the host;
  AgentMon **MUST** treat this as an expected condition (the durable event was already delivered via
  the hook path) and **MUST NOT** surface an error.

### 6.1 Operating without MCP (hooks-only mode)

> **Status: current.** Verified: `apps/cli/src/commands/cli.integration.test.ts`, describe block
> `hooks-only delivery parity (issue #270)`, test "daemon up, monitor fires, hook deliver claims a
> real stdin payload, events ack acknowledges, events list reflects it — zero MCP/channel
> involvement"; capability-parity assertions in
> `apps/cli/src/commands/channel-hooks-ipc-parity.test.ts`.

**MCP is never required.** The hook-deliver transport (§5) plus the CLI's `session`/`hook`/`events`
commands are the **complete** delivery surface: every capability the channel transport (§4) offers —
delivery, claiming, acknowledgement, status — is reachable through hooks and the CLI alone, over the
same daemon IPC (§2's "realization" note). This is not an aspiration; it is proven end to end by the
`hooks-only delivery parity` scenario, which drives daemon boot (`session start`, fed a real
`SessionStart` stdin payload), a monitor firing, delivery claim (`hook deliver`, fed a real
`UserPromptSubmit` stdin payload), acknowledgement (`events ack`), and confirmation (`events list`)
— without ever importing, starting, or referencing the channel/MCP code path.

Capability parity is not incidental, it is structural: the `agentmon_ack` MCP tool's entire
implementation (`apps/cli/src/commands/channel.ts`) routes through `acknowledgeEventsClient`, the
identical daemon-IPC client function the `events ack` CLI command calls (§4.3). The channel's outbound
push and `hook deliver` both drive the SAME underlying reserve → validate-fit → render → commit
sequence (§5.5) — `reserveDeliveryClient`/`commitDeliveryClient`/`releaseDeliveryClient`
(`channel.ts`'s `runChannelDeliveryCycle`, `hook.ts`'s `reserveRenderAndCommitHookDelivery` — issue
#442, PR #442 rounds 8–9) — rather than a single direct `claimDeliveryClient` call: neither transport
may durably consume a delivery before it has actually been surfaced (a fallible MCP push for the
channel; a render that must complete and be written before the commit, for the hook). Only the
manual, single-shot `hook claim` subcommand still calls `claimDeliveryClient` directly — it has no
fallible surface to defer a commit behind. Every path still bottoms out on the SAME core delivery
decision (`decideDelivery`/`applyDelivery`, `service.ts`) and the same `hook.claim` IPC method on the
daemon ([002 §10](./002-runtime-delivery.md)); every transport — hooks, CLI, or channel — drives the
same underlying decision. Disabling or stripping the MCP server therefore changes nothing about
_what_ is delivered, _when_, or _how_ urgency/lifecycle are honored (§6 above) — the only thing that
changes is which surface renders it: an `additionalContext` hook injection instead of a `<channel>`
tag, and an explicit `agentmonitors events ack` invocation instead of the in-session `agentmon_ack`
tool call.

This is the mode a restricted corporate environment that disallows unblessed MCP servers should use:
install the CLI, install the plugin's `hooks/hooks.json` (omit or block `.mcp.json`), and
delivery/acknowledgement continue to work exactly as documented in §5. See
[`agent-plugins/agentmonitors/README.md`](../../agent-plugins/agentmonitors/README.md) for the
practical hooks-only setup instructions and the CLI equivalents of the MCP affordances.

## 7. Out of Scope

- **Permission relay** (`claude/channel/permission`, `notifications/claude/channel/permission_request`
  / `permission`): AgentMon is a work-signal system, not a tool-approval bridge. Not implemented, not
  planned here.
- **AgentMon as a consumer of inbound channel messages** (a "channel" source): channels push into a
  session, not into the daemon; this is not the integration's shape.

## 8. Examples

### 9.1 A high-urgency delivery rendered as a channel event

A settled high-urgency `file-fingerprint` claim surfaces as:

```text
<channel source="agentmonitors" monitor_id="build-config-drift" urgency="high"
         object_key="/repo/package.json" event_id="01J…"
         event_count="1" lifecycle="turn-interruptible">
### build-config-drift (high)
package.json changed

Review whether build behavior or dependency state needs updating.

Changes:
- "version": "1.0.0"
+ "version": "1.1.0"
</channel>
```

**What this proves:** the same `DeliveryClaim` the hook path would surface is rendered into the
channel field schema, carrying the same event content (title + monitor body + bounded change
summary, §4.2.1) — not the title alone; `event_id` is available for the ack tool.

### 9.2 Acknowledgement round-trip

1. The agent reads the `<channel … event_id="01J…">` tag and calls
   `agentmon_ack({ event_ids: ["01J…"] })`.
2. The server re-authorizes that `01J…` belongs to the bound workspace's session, then routes through
   the daemon's `events ack` path.
3. The event moves unread → acknowledged (SP4); the claim made by the push did **not** already
   acknowledge it (BP2).

**What this proves:** the two-way reply mechanism maps cleanly onto AgentMon's distinct
claimed-vs-acknowledged states.

## 9. Validation Implications

Transport and integration tests should be able to prove:

- a transport renders a `DeliveryClaim` without re-deriving delivery decisions (same events as the
  runtime emitted);
- surfacing via any transport marks rows claimed but not acknowledged (BP2);
- a fallible transport does not mark a delivery claimed before it surfaces it: a rejected/disconnected
  push leaves the rows unclaimed and eligible for hook fallback, a successful push commits the claim,
  and neither path acknowledges (reserve → commit/release, §4.5.1, issue #300);
- a channel push and the hook path do not double-surface the same event (cross-transport dedup, §4.5),
  including while a reservation is in flight (leased rows are hidden from a concurrent hook claim);
- meta keys are identifier-safe and values are tag-breakout-sanitized (§4.6);
- with the channel transport disabled/blocked, delivery still completes via the hook path with no
  error (§5);
- workspace binding resolves the correct lead session when `W` has one lead, and degrades (no
  ambiguous claim) when `W` has multiple leads (§4.4).
- the full lifecycle (boot, fire, claim, acknowledge, confirm) completes via hooks + CLI alone, with
  no import/start/reference of the channel/MCP code path, and the ack/claim CLI commands drive the
  identical daemon-IPC client functions the MCP tool uses (§6.1).

## 10. Open Questions

- **Resolved (Claude Code 2.1.157; re-confirmed 2.1.160):** a stdio MCP server receives
  `CLAUDE_PROJECT_DIR` (= workspace), has its cwd set to the workspace, inherits
  `CLAUDE_CODE_SESSION_ID`, and can call `roots/list`. The binding strategy in §4.4 is therefore
  confirmed. **Caveat:** `CLAUDE_CODE_SESSION_ID` is _not_ in the documented MCP env contract (mcp.md
  lists only `CLAUDE_PROJECT_DIR` + `roots/list`), so its inheritance is observed-not-contracted and
  host-version-dependent — re-run the `experiments/channel-probe` diagnostic when targeting a new
  host, and keep the workspace-binding fallback (§4.4 #2) as the documented-safe path.
- **Resolved (Claude Code 2.1.160):** `CLAUDE_CODE_SESSION_ID` equals the `hostSessionId` the
  `SessionStart` hook passes to `session open`. The 2.1.160 re-verification above established that
  the env var's value exactly equals the live session id, and the hook (post stdin-input fix, §5.0)
  passes the stdin `session_id` — by the hooks contract, that same live session id. Both transports
  therefore resolve the same identifier. Same caveat as above: the env-var side is
  observed-not-contracted, so re-verify alongside the channel-probe diagnostic on new host versions.
- Decide whether the channel server should open a synthetic workspace-lead session when channels are
  used **without** the hook-driven `session open` flow, or require the hook flow as a precondition.
- **Multi-host (§11):** the concrete per-host lifecycle-hook names, session-identity signals, and
  workspace-binding mechanisms for Codex and Cursor (CLI + desktop) are **not yet pinned** — they
  **MUST** be confirmed with a per-host probe diagnostic (the `experiments/channel-probe` pattern
  generalized) before each host's adapter is marked _current_. §11 fixes the adapter **contract**;
  the probe fills the matrix cells.

## 11. Multi-Host Adapter Matrix (_target_)

> **Status: target.** This section generalizes the single Claude Code adapter to the local hosts
> greenlit in Epic #259 — **Claude Code, Codex, and Cursor, each in a CLI and a desktop/IDE
> surface**. Every rule here is target; each host's adapter **MUST** be moved to _current_ with
> `verified:` references (adapter module + integration test + a pinning probe) when it ships, and the
> matching [roadmap.md](./roadmap.md) gap retired. Scope is **local hosts only** — no cloud-hosted
> agents ([NP5](./000-principles.md); the web-agent defer stands, see closed #126).

### 11.1 The adapter contract, restated for N hosts

A new host is a **new adapter**, never a change to the runtime core (the host-agnostic-core
invariant, [002 §11.1](./002-runtime-delivery.md), AP3). Each host's adapter **MUST** satisfy the
existing `AgentRuntimeAdapter` contract ([002 §11.1](./002-runtime-delivery.md),
`libs/core/src/adapter/types.ts`) — `name`, `hookEventMap`, `defaultHookStatePath`,
`createSessionInput`, `materializeHookState` — plus provide, for its host, the following **contract
dimensions** (some are implied by the existing members; §11.2 makes them explicit so a matrix cell is
unambiguous):

1. **Lifecycle-event mapping** (`hookEventMap`) — map each of the seven `AgentLifecycleEvent`s
   (`session-opened`, `session-dormant`, `turn-interruptible`, `turn-ended`, `turn-idle`,
   `pre-compact`, `post-compact`) to the host's concrete lifecycle-hook name. A host that lacks an
   analogue for a given event **MUST** omit/degrade that event's delivery rather than invent one
   (the missing lifecycle simply does not fire; the durable event is still recoverable at the next
   supported lifecycle, PP1).
2. **Delivery lifecycle points** — identify which host events correspond to the three
   `DeliveryLifecycle`s (`turn-interruptible`, `turn-idle`, `post-compact`) **and** which of them
   honor **advisory, non-blocking context injection** (the `additionalContext` analogue of §5.4). The
   adapter **MUST** emit delivery only at events that honor advisory injection; emitting at an event
   that ignores it is a silent no-op (the §5.4 rule, generalized).
3. **Session identity** — a documented, stable way to resolve the **host session id**
   (`hostSessionId`) for a given invocation, so events project into the right session
   ([002 §6.1](./002-runtime-delivery.md)). Whether it arrives on **stdin** (Claude hooks, §5.0), in
   an **environment variable** (Claude MCP/channel, §4.4), or by a host-specific mechanism is the
   adapter's concern; the resolved value **MUST** be the same id the session was opened under
   (`session open --host-session-id …`).
4. **Workspace binding** — a documented way to resolve the **workspace path** (`workspacePath`) for
   the invocation (env var, process cwd, an MCP `roots/list` analogue, or an explicit flag), so
   per-workspace daemon isolation ([002 §10.2](./002-runtime-delivery.md)) and workspace-scoped
   projection hold.
5. **Delivery-surface state** (`defaultHookStatePath` / `materializeHookState`) — a per-session state
   location and serialization the host's integration reads (the hook-state file, or the
   host-appropriate equivalent). The default hook-state **path** shape
   (`<workspace>/.agentmonitors/sessions/<encoded-session>/hook-state.json`,
   [002 §11.3](./002-runtime-delivery.md)) is host-generic and SHOULD be reused unless a host
   requires otherwise.
6. **Availability & fallback** — a **portable baseline** transport that always works for the host
   (the hook-state / advisory-injection path, §3/§5), plus any **richer, additive** transport the
   host offers (a channel/MCP-push analogue, §4). The richer transport **MUST** be additive and
   **MUST NOT** change delivery semantics (the generalized NP-CH rule of §6): same events, same
   urgency, same unread/claimed/acknowledged model — only the surface.

### 11.2 Which parts of this document are Claude-specific vs host-generic

A new adapter re-implements the **Claude-specific** rows below and **inherits** the host-generic ones
unchanged. This classification is itself normative: a host-generic rule **MUST NOT** be re-decided
per host, and a Claude-specific rule **MUST NOT** be assumed to hold for another host without a probe.

| Concern                                                                                    | Host-generic (inherited) |  Claude-specific (re-provide per host)   |
| ------------------------------------------------------------------------------------------ | :----------------------: | :--------------------------------------: |
| Transport seam: consume `DeliveryClaim`, don't re-derive (§2)                              |            ✅            |                                          |
| Claimed-not-acknowledged (BP2); lead-only projection ([002 §6](./002-runtime-delivery.md)) |            ✅            |                                          |
| Urgency + lifecycle preservation ([002 §9](./002-runtime-delivery.md))                     |            ✅            |                                          |
| Cross-transport dedup via claimed state (§4.5)                                             |            ✅            |                                          |
| Content safety for any injecting transport (§4.6)                                          |            ✅            |                                          |
| Availability/fallback **principle** (§6, NP-CH generalized)                                |            ✅            |                                          |
| Interpret-adapter boundary exists (§2.1) — tool invocation behind an adapter               |            ✅            | concrete tool/argv is host/user-specific |
| `hookEventMap` **values** ([002 §11.2](./002-runtime-delivery.md))                         |                          |                    ✅                    |
| Hook **stdin** JSON contract: `session_id` / `hook_event_name` / `cwd` (§5.0)              |                          |                    ✅                    |
| Context-event set honoring `additionalContext` + wire shape (§5.1, §5.4)                   |                          |                    ✅                    |
| `<channel>` MCP push mechanism + field schema (§4.1–§4.2)                                  |                          |                    ✅                    |
| Binding signals `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR` / `roots/list` (§4.4)      |                          |                    ✅                    |
| Activation packaging (aipm marketplace, `hooks.json`, `.mcp.json`) (§5.6)                  |                          |                    ✅                    |

### 11.3 The matrix

Columns are the six local host surfaces in scope; rows are the §11.1 contract dimensions. The
**Claude Code** column is _current_ today (verified in `libs/core/src/adapter/claude.ts` and §3–§6
above); the **Codex** and **Cursor** columns are **target** — each cell marked _(probe)_ **MUST** be
pinned by a per-host diagnostic before that adapter ships (§11.6). Illustrative host details are
marked _(unverified)_ where they reflect a plausible but not-yet-probed mechanism.

| Contract dimension                                 | Claude Code (CLI / desktop)                                                                                                                | Codex (CLI / desktop)                                                                   | Cursor (CLI / IDE)                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Lifecycle mapping** (`hookEventMap`)             | current — SessionStart / SessionEnd / PreToolUse / Stop / TeammateIdle / PreCompact / PostCompact ([002 §11.2](./002-runtime-delivery.md)) | _(probe)_ map to Codex lifecycle hooks; omit unsupported                                | _(probe)_ map to Cursor hooks; omit unsupported                                    |
| **Delivery lifecycle points + advisory injection** | current — context events `UserPromptSubmit` / `PostToolUse` / `SessionStart` honor `additionalContext` (§5.4)                              | _(probe)_ identify advisory-injection-capable events                                    | _(probe)_ identify advisory-injection-capable events                               |
| **Session identity** (`hostSessionId`)             | current — stdin `session_id` (hooks, §5.0); `CLAUDE_CODE_SESSION_ID` (MCP, §4.4)                                                           | _(probe)_ host-provided id signal                                                       | _(probe)_ host-provided id signal (unverified — e.g. a `CURSOR_`-prefixed env var) |
| **Workspace binding** (`workspacePath`)            | current — stdin `cwd` → `CLAUDE_PROJECT_DIR` → cwd (§5.0); `roots/list` (§4.4)                                                             | _(probe)_ env / cwd / roots analogue                                                    | _(probe)_ env / cwd / workspace-folder analogue                                    |
| **Delivery-surface state**                         | current — `hook-state.json` path (§3, [002 §11.3](./002-runtime-delivery.md))                                                              | inherit path shape unless host requires otherwise                                       | inherit path shape unless host requires otherwise                                  |
| **Portable baseline transport**                    | current — hook-deliver / hook-state (§3, §5)                                                                                               | _(probe)_ hook/notify-command analogue; else the best always-available advisory surface | _(probe)_ hook analogue; else best always-available advisory surface               |
| **Richer additive transport**                      | current — Claude channel MCP push (§4)                                                                                                     | _(probe)_ MCP/push analogue if any; additive only                                       | _(probe)_ MCP/push analogue if any; additive only                                  |

### 11.4 CLI vs desktop surfaces

Each host is scoped with **two surfaces** (CLI and desktop/IDE). The default rule:

- a host's two surfaces **SHOULD** be served by **one adapter** for that host when they share the
  same lifecycle-hook, session-identity, and workspace-binding mechanisms;
- if a host's CLI and desktop surfaces expose **different** integration mechanisms (e.g. the CLI
  drives stdin hooks while the desktop only offers an MCP/extension surface), the adapter **MUST**
  branch on the surface internally (a `surface: 'cli' | 'desktop'` distinction inside the one
  host adapter) rather than misreport one surface's mechanism for the other. It **MUST NOT** be
  split into two unrelated adapters that duplicate the host's delivery semantics.

> **Decision flagged (§10):** whether any in-scope host actually needs the internal CLI/desktop
> branch is a per-host probe outcome; the contract only requires that the branch exist **if** the
> mechanisms diverge.

### 11.5 Delivery semantics are invariant across hosts

Adding a host **MUST NOT** change any delivery semantic. For every adapter:

- events, urgency bands, and the three delivery lifecycles are identical to Claude's
  ([002 §9](./002-runtime-delivery.md)); a host only changes _the surface and the trigger events_,
  never _what_ is worth delivering or _when_ it settles (that is runtime-owned, AP3/PP9);
- surfacing marks rows **claimed**, never **acknowledged** (BP2); acknowledgement stays an explicit
  act (SP4);
- only **lead** sessions receive deliveries ([002 §6](./002-runtime-delivery.md));
- the agent-facing verbs and ephemeral-monitor declaration of
  [007](./007-agent-facing-interaction.md) resolve session identity through **this same adapter
  contract** (§11.1 dimension 3), so they work on every host an adapter supports.

### 11.6 Validation implications

Per [004 §6](./004-validation-testing.md), each host adapter, when it ships, **MUST** carry:

- an **integration test** that drives the host's **real input contract** — the actual lifecycle-hook
  command string(s) and stdin/-env payload shape — end to end (boot, deliver, deregister), the
  [004 §3.5](./004-validation-testing.md) "config-drift" pattern already applied to the Claude
  `hooks.json`, not a hand-built approximation;
- a **binding-probe artifact** (the `experiments/channel-probe` pattern generalized) that records the
  host version and confirms the session-identity and workspace-binding signals the matrix cell
  claims, so an observed-not-contracted signal is re-verifiable on a new host version (the §4.4
  caveat, generalized);
- proof that **delivery semantics are unchanged** vs the Claude adapter (§11.5): same claimed-not-ack
  behavior (BP2), same lead-only projection, same urgency/lifecycle handling.

## 12. Transport Health & Heartbeats (_current_ — issue #425)

A transport that is **up** is not a transport that is **delivering**. Both transports can silently
diverge from the workspace they were meant to serve, and every divergence presents identically —
nothing arrives — while every surface looks green. Three distinct instances of this were observed in
a single day of dogfooding: a reaped daemon with no session to revive it; a channel server bound to
the home-directory workspace because the session was launched from `$HOME`; and correct, materialized
events whose reminders were withheld on every lead session by the `coalesced-until-ack` guard
(002 §9.2/§9.3). The third is the important one: both transports were connected and correctly
configured, and the agent was still never told its PR's CI had broken.

### 12.1 Why each transport needs a heartbeat

The two transports fail in opposite ways, and neither is observable without a record:

- **`hook deliver`** spawns a fresh CLI per prompt, re-resolving its workspace, socket, and binary
  every time. It self-heals, but leaves no trace — so "are the hooks installed at all?" is
  unanswerable from outside, and "installed but idle" is indistinguishable from "never installed".
- **`channel serve`** is a long-lived MCP subprocess that **freezes** its environment (`HOME`,
  `CLAUDE_PROJECT_DIR`, resolved socket, CLI binary) at session start. It keeps looking connected
  long after any of those stops matching reality.

Each therefore writes a **transport heartbeat** naming the process, the exact binary and version
serving it, the environment it resolved, the workspace and socket it bound to, and when it last
actually delivered. `channel serve` refreshes its record on an independent timer (§12.2.1), not only
after each poll settles, and removes it on clean shutdown; `hook deliver` writes one per invocation
once it has resolved a session, plus a second — recording a delivery timestamp only when it actually
wrote output to the host — once it knows whether it surfaced anything. Every write is a
read-modify-write on the delivery timestamp specifically: a write that has nothing new to report
(an empty prompt, a poll cycle with no delivery) preserves whatever `lastDeliveryAt` the prior write
already recorded, rather than resetting it — a per-invocation whole-record overwrite that dropped this
would make `lastDelivery` read `never` on almost every hook invocation, inverting its diagnostic
purpose.

Every write is also atomic and symlink-safe (issue #425 review, round 4), mirroring
`writePrivateFileAtomic` (000, local-permissions.ts): the record is written to a deterministic sibling
temp path, then renamed into place. Because the registry directory predates the 0700-owner-only
migration in some installs, the temp path cannot be trusted blindly — a symlink planted there while
the directory was still permissive would let a plain `writeFileSync` follow it and clobber whatever it
points at. The write therefore removes any pre-existing path at the temp location first (`rm` does not
follow symlinks) and (re)creates it with `O_EXCL`, which refuses to follow a symlink planted between
the two calls, before writing and renaming.

### 12.2.1 The channel heartbeat is not gated on the poll settling

`channel serve`'s heartbeat refreshes on its own timer, independent of how long any single poll's
reserve/commit/release IPC round trip takes. Refreshing only from inside the poll would tie this
transport's liveness signal to the daemon's latency: a daemon wedged longer than the channel's TTL
would make a live, correctly-bound server lapse to `heartbeat-stale` — blaming the transport for the
daemon's outage, the same class of mis-attribution the daemon-unreachable/transport-defect split in
§12.4 exists to avoid elsewhere.

### 12.2 Leases, not just timestamps

**Reaping is a WRITE-path responsibility, never a read.** An expired record is removed only when a
transport writes its own heartbeat — a live process re-registering, which is the genuine
reconciliation event. Reads never mutate the registry. Folding GC into the read made the health
surface destroy the evidence of the failure it had just reported: the first `doctor` reported a
stale channel and exited non-zero, and the second — with the same active lead, the same daemon, and
nothing recovered — found no record, took the "no transport has ever reported in" branch, and exited 0. A dead server appeared fixed purely because somebody looked at it, and `doctor` mutated state,
which 005 §15 says it never does. A lapsed transport therefore keeps reporting its failure on every
health check until something actually re-registers.

Every record carries an explicit `ttlMs` alongside `updatedAt`. A server killed without cleanup
(SIGKILL, host crash) leaves its file behind, so a reader must be able to judge the record dead
**without trusting the writer to have removed it**. Expressing the bound as an owner-declared TTL
rather than a reader-side constant keeps that judgement correct if a future writer heartbeats on a
different cadence, and gives a lease primitive a later daemon-lifetime policy can consume directly.
The two TTLs differ by design: the channel's is short (tens of seconds, well above its poll cadence),
while the hook's spans a day — there is no hook process between prompts, so a short lease would
report a perfectly healthy setup as dead during any human pause.

**A lapsed record is reaped, not left forever — but only via a write.** The registry is scanned
opportunistically on the WRITE path only (never on read, per the paragraph above); a record found
expired-past-its-own-TTL is still returned to whichever reader observed it in the meantime (so the ONE
report that catches it still reports `heartbeat-stale` accurately, potentially across many `doctor`
runs), but its backing file is removed the next time ANY transport on the machine writes a heartbeat.
Without this, an uncleanly-killed transport's file would sit on disk forever — every subsequent
`doctor` run in that workspace would fail `[heartbeat-stale]` permanently, even long after no lead
session was ever open again, which is precisely the "cry wolf on nothing actually open" outcome the
health surface exists to avoid (005 §15).

**A future `updatedAt` is stale, not "fresh forever" (issue #425 review, round 4).** Staleness is
computed as `now - updatedAt > ttlMs`; a record whose `updatedAt` is somehow ahead of `now` (clock
skew between writer and reader, or a corrupt/forged record) makes that difference negative, which is
never `> ttlMs` no matter how far in the future the timestamp claims to be — such a record would never
age out. Beyond a small clock-skew tolerance (a few seconds), a future `updatedAt` is therefore treated
as stale, the same conservative direction already used for an unparseable timestamp: it both restores
GC (an un-aging record was invisible to the reaper above) and stops `doctor` from reporting a dead or
bogus transport as `running` indefinitely.

### 12.3 Registry layout is load-bearing

Records live in a machine-wide registry under the resolved data root
(`<dataRoot>/agentmonitors/transports/`), **not** inside the per-workspace data directory. Storing a
channel heartbeat inside the workspace _it resolved_ would make the most important failure mode
undetectable by construction: a server bound to workspace X could never be seen by a health check
run in workspace Y. A flat registry lets the health surface enumerate every transport on the machine
and match a record to **this** session by host session id, turning "your channel is listening to a
different workspace" from an invisible absence into a reported finding.

**Both transports key their record by host session id when one is known** (`heartbeatKey`, issue #425
review, round 6 follow-up) — `hook deliver` no longer overwrites one workspace-wide record per
prompt. Each active lead's own invocation leaves its own record, bounded by SESSIONS rather than
prompts (a session overwrites only its own record; a stale one is reaped on the next write). This
fixed a permanent false RED: with the OLD workspace-keyed record, two active leads that had both just
run `hook deliver` successfully still produced only one file (the second prompt overwrote the first),
so the every-active-lead-covered rule (§12.5) could never tell that genuine gap apart from a
perfectly healthy multi-session workspace — whichever lead prompted second always read as uncovered.

**Cross-workspace matching, however, still applies only to `channel`.** `channel serve` is one
long-lived process per host session, so matching its record by host session id — across EVERY
workspace, not just this one — is exactly what detects the misbinding case above (§12.1 case 2): a
session whose channel record names a different workspace entirely. `hook` has no analogous
cross-workspace identity to misresolve — it is a fresh process per prompt with nothing that persists
between workspaces — so its heartbeats are still matched same-workspace-only.

**Within that same-workspace pool, `hook` selection is now filtered to ACTIVE leads first, matching
`channel` (issue #425 review, round 8).** Same-workspace is not the same as "evidence for THIS
diagnosis": a closed or non-lead session's still-in-TTL record lives in the same registry entry set
as an active lead's own record, and returning every same-workspace record unfiltered let it poison
the active aggregate — a direct probe with one healthy active-lead record plus one closed-session
record bound to an obsolete socket produced `socket-mismatch` and flipped a healthy workspace's
`reach`/`deliverable` to `none`/`false`. Records naming an ACTIVE lead are preferred; every
same-workspace record is returned only as a fallback when none of them match an active lead, so a
workspace with hook evidence but no lead currently open still shows what it has rather than reporting
"not configured". The every-active-lead-covered rule (§12.5) still needs the full set of ACTIVE lead
ids that have fired hook here, not a single representative — filtering to active-lead matches when
they exist does not reduce that to one, since several active leads each leave their own record.
Applying `channel`'s cross-workspace-first selection to `hook` too would let a session whose hook
last fired in workspace A — now leading workspace B, before its first prompt there — find no matching
record in B's workspace-filtered set at first prompt, when in fact that is the ordinary, self-healing
"not fired yet" case (`hook-lead-uncovered`, §12.5), not a misbinding.

A transport running under a genuinely different `HOME`/`XDG_DATA_HOME` resolves a different data root
and is invisible from here. That case is reported honestly as an **absence** whose wording names the
possibility — never as a clean bill of health.

**The registry key is collision-safe.** A host session id is untrusted input; the key sanitizer both
collapses everything outside a conservative filename allowlist to `_` (so a `/` or `..` cannot escape
the registry directory) AND appends a short hash of the RAW, unsanitized, untruncated id. Without the
hash suffix, two distinct ids that collapse to the same cleaned prefix (`run:1` and `run_1`) — or that
differ only past the truncation point — would silently share one file, letting one session's
heartbeat clobber another's and a reader judge the wrong session's binding.

### 12.4 What the health surface must report

`agentmonitors doctor` renders the verdict (005 §15, "Delivery transports"). Its contract:

1. Name the listening method — `hook`, `channel`, `both`, or `none`.
2. Report each cause **distinctly**, never collapsed into one generic "unhealthy": an absent daemon,
   a workspace/socket/environment misbinding, muted reminders, and a lapsed heartbeat share only
   their symptom and have entirely different fixes.
3. Attach a concrete remediation — a command or a specific action — to every problem.
4. Separate "which method is listening" from "will anything actually arrive right now". Suppression
   is precisely where those two answers diverge, and reporting only the first is what hid a real CI
   failure.
5. Never report "unknown" as "healthy". Answering (4) requires asking the daemon, per lead session,
   whether a reminder is currently suppressed; if that ASK itself fails (an older daemon rejecting the
   request as unsupported, or a connection error), `doctor` must say so explicitly
   (`delivery-diagnosis-unavailable`, 005 §15) rather than silently treating a failed check the same
   as a check that ran and found nothing — the latter is exactly the false-green issue #425 review
   round 4 found.
6. "One active lead is covered" is not "every active lead is covered", and "the representative record
   is fine" is not "every matching record is fine" (issue #425 review, round 5) — see §12.5.

### 12.5 Every active lead, not just one — and never a corrupt record (issue #425 review, round 5)

A fifth review round found that "ACTIVE leads only" (round 3) still let a workspace-wide aggregate
misreport per-session facts as a clean bill of health, and that a corrupt or forged record could win
representative selection over a valid one:

- **`hasLeadSession` must mean ACTIVE, consistently, everywhere.** `MonitorDoctorReport.leadSessions`
  includes sessions a prior `session close` already marked `dormant` — durable records the store keeps,
  not sessions with a live host process. `computeTransportHealth`'s own `leadHostSessionIds` input
  (round 3) was already filtered to active sessions, but `doctor`'s OTHER gates (`lead-session`,
  `daemon-reachable`'s idle/fail split, the per-monitor rollup, the JSON `leadSession` field, and the
  delivery-diagnosis fetch) read the unfiltered `hasLeadSession`/`leadSessions` instead — so a closed
  session's leftover, in-TTL heartbeat could read `deliveryWillReachThisSession: 'none'` while
  `lead-session` still reported `pass` for the same run. The ACTIVE lead-session set must be derived
  exactly once and threaded through every one of these consistently; a closed session is `idle`/exit 0
  everywhere, the same as a workspace with no lead session ever registered.
- **A channel record matching one active lead does not prove it matches all of them.** With two active
  leads and a channel heartbeat for only one, "at least one active lead has a matching channel
  heartbeat" is satisfied — the round-4 fix's own bar — while the SECOND active lead has no channel
  listener whatsoever. `channel-lead-uncovered` (005 §15) names every active lead a channel record
  exists for the workspace but not for that lead, and is blocking: it is unioned into the channel's
  problems and, per below, excludes the channel from the listening method.
- **A transport-owned blocking problem on ANY matched record — not just the representative one —
  disqualifies the listening method.** A stale sibling session's `heartbeat-stale` (or the
  `channel-lead-uncovered` problem above) is unioned into `problems` regardless of which record is
  chosen as representative, but "is this transport the listening method" must derive from that SAME
  union, not from the representative record's own staleness alone — otherwise a fresh, healthy
  representative can mask a broken sibling and still report `deliveryWillReachThisSession: 'channel'`,
  `deliverable: true`, and a verdict ending in "(healthy)".
- **Representative selection is freshness-first, not problem-count-first, and both unparseable and
  out-of-tolerance-future timestamps sort as oldest.** Round 4 picked the record with the MOST problems
  as representative, specifically so a broken sibling would be shown rather than hidden — but an
  unparseable `updatedAt` contributes its own `heartbeat-stale` problem, so that same rule could make a
  CORRUPT record the representative even alongside a valid, current one, reporting `running: false` for
  a transport that is actually up. Representative selection is now freshness-first (ties broken by
  problem count), with a corrupt or implausibly-future timestamp — the same conservative direction
  `isHeartbeatStale` already applies — sorting as oldest either way. Nothing is hidden by this: every
  matching record's problems are still unioned into the transport's `problems` regardless of which one
  is chosen as representative.

### 12.6 What a heartbeat cannot prove

During the channels research preview, Claude Code loads the plugin's channel MCP server as a _plain_
MCP server unless the session was started with
`--dangerously-load-development-channels plugin:agentmonitors@agentmonitors` (or the plugin is on the
approved channel allowlist). In that state the server connects and `mcp.notification()` resolves
normally, but the host **never registers a channel listener and drops the events with no error
returned to the server**. "Channel transport: connected" is therefore not sufficient for healthy, and
the server cannot detect the difference from its side.

The surface reports this as an explicitly-unverifiable **advisory** rather than either asserting
health it cannot prove or crying wolf about a condition that is usually absent: it does not mark the
channel unhealthy, and it points at `agentmonitors verify` (an end-to-end proof) plus the dev-flag
remediation. A future active probe — emit a synthetic channel event, confirm the claim/ack lands back
in the store within a bound — would upgrade this from advisory to detection.

### 12.7 A hold's `claimedEventIds` is optional, and neither its absence nor emptiness is ever an ack-all fallback (issue #425 review, rounds 7–8)

`HookDeliveryHold.claimedEventIds` (round 6, §12.4 item 3 / 005 §15 "reminders-suppressed") is
**optional** on the `@agentmonitors/core` public type, not required. A `HookDeliveryDiagnosis`
crosses the daemon IPC boundary, so it can arrive from a build that predates the field entirely — the
type describes what THIS build produces, not what a remote peer actually sent on the wire.

`doctor` must treat a suppressing (`already-claimed` / `coalesced-until-ack`) hold whose
`claimedEventIds` is not a real, NON-EMPTY array of non-empty strings as **diagnosis-unavailable for
that session** (`delivery-diagnosis-unavailable`, §12.4 item 5), never as:

- **A broken command.** Folding a missing field into the same ids list as a genuinely populated one
  renders a malformed, blank `--event-ids  --socket ...` flag — worse than treating it as untrustworthy,
  because it looks like a safe, scoped command while actually being broken.
- **An ack-all fallback.** Falling back to a bare `agentmonitors events ack --session <id>` (no
  `--event-ids`) would re-introduce exactly the blanket-acknowledgement defect round 6 fixed:
  clearing every unread row for the session, including work the agent never claimed or saw. This
  applies equally to a MISSING field (round 7) and to an EMPTY array (round 8): `classifyReminderHold`
  only ever returns an `already-claimed`/`coalesced-until-ack` hold when at least one event is
  claimed, so a real hold from this build always names at least one id — an empty array reaching
  `doctor` can only mean the value came from something other than that classifier (a malformed daemon
  response, or a hand-built `HookDeliveryHold`) and must be treated exactly like a missing one, not
  folded into the scoped-remediation branch where an empty list renders as "omit the flag" and
  silently falls back to acknowledging every unread event.

An empty array (`[]`) IS still a valid, deliberate signal for `settle-window` holds — nothing is
claimed while pending work merely waits out the settle window — but `settle-window` never reaches
this check at all: only `already-claimed`/`coalesced-until-ack` holds are suppressing holds, and for
those two reasons an empty array is never legitimate. Only a real, non-empty array of non-empty
strings is trustworthy.
