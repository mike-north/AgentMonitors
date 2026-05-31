# 006 — Agent Integration & Delivery Transports

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md)
> **Covers:** the adapter seam, the delivery-transport abstraction, the hook-state transport
> (current), the Claude Code **channel** transport (target), workspace/session binding,
> cross-transport deduplication, and the availability/fallback contract

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

| Section                        | Principles         |
| ------------------------------ | ------------------ |
| Transport seam & contract      | PP4, AP1, AP3, AP6 |
| Hook-state transport (current) | PP4, AP1, BP2      |
| Channel transport (target)     | PP4, BP2, NP-CH    |
| Availability & fallback        | PP7, NP-CH         |

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

> **Design note.** This is a target refactor. The current code has no `DeliveryTransport` type; the
> hook-state behavior lives directly in the runtime + adapter. The transport seam is introduced so a
> second transport can be added without changing what the runtime decides.

## 3. Hook-State Transport (Current)

The hook-state transport is the portable default and is fully specified in
[002 §8 (Hook State)](./002-runtime-delivery.md) and [002 §11 (Adapters)](./002-runtime-delivery.md).
Summary of its contract here: per-session `hook-state.json` is refreshed each tick; Claude Code hooks
read it at lifecycle points and surface reminders/claims. It binds at **session** granularity
(keyed by `(adapter, hostSessionId)`), so its unread/claimed accounting is exact per session.

This transport has **no external availability requirement** beyond the host's hook mechanism and is
the baseline every environment can use.

## 4. Channel Transport (Target)

> **Status: target.** Not implemented. This section specifies the intended contract so it can drive
> a prototype and is tracked in [roadmap.md](./roadmap.md) (G7).

A channel is an MCP server Claude Code spawns over stdio that pushes events into the session as
`<channel …>` tags. AgentMon ships a channel server that bridges the daemon's deliveries onto that
surface. (Channel mechanism reference:
<https://code.claude.com/docs/en/channels-reference.md>.)

### 4.1 Mechanism

The AgentMon channel server:

- declares the channel capability: `capabilities.experimental['claude/channel'] = {}`;
- connects to the AgentMon daemon over its existing Unix-socket IPC
  ([002 §10](./002-runtime-delivery.md)) — it is a thin MCP front-end over the same surface that
  `hook claim` / `events` already use, not new core logic;
- pushes each settled `DeliveryClaim` for its bound session as a `notifications/claude/channel`
  event.

### 4.2 Notification field schema

The runtime's existing `DeliveryClaim` renders into the channel notification's two params. Field
conventions follow the bundled reference channels (snake_case identifier keys, string-only values,
multi-values flattened):

- **`content`** (string): the rendered delivery summary — the concrete events for a high-urgency
  claim, or the coalesced reminder text for normal/low — exactly what `claimDelivery` already
  produces. AgentMon authored/observed text is **untrusted** (see §4.6).
- **`meta`** (`Record<string,string>`): routing/context attributes. Keys **MUST** be identifiers
  (`[A-Za-z0-9_]`); hyphens are silently dropped by the host, so kebab fields are converted:

  | meta key      | value                                                 | notes                              |
  | ------------- | ----------------------------------------------------- | ---------------------------------- |
  | `monitor_id`  | the monitor's ID                                      |                                    |
  | `urgency`     | `low` \| `normal` \| `high`                           |                                    |
  | `event_kind`  | `mutation` \| `notification` \| `alert`               | NOT `event-kind` (hyphen dropped)  |
  | `object_key`  | the event `objectKey`                                 | sanitized (§4.6)                   |
  | `event_id`    | the durable event ID                                  | passed back by the ack tool (§4.3) |
  | `event_count` | number of coalesced events, stringified               |                                    |
  | `lifecycle`   | `turn-interruptible` \| `turn-idle` \| `post-compact` |                                    |

The `source` attribute on the rendered `<channel>` tag is set by the host from the MCP server name
(e.g. `agentmonitors`), not by `meta`.

### 4.3 Two-way: acknowledgement tool

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

A spawned MCP server **cannot** learn its host session id today: there is no `CLAUDE_SESSION_ID`, and
nothing session-identifying in the MCP `initialize` handshake. It **can** learn its **workspace**:
Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned server's environment (and the server may call
MCP `roots/list`). Reference: <https://code.claude.com/docs/en/mcp.md>.

Therefore the channel transport binds at **workspace granularity**:

- the server reads `CLAUDE_PROJECT_DIR` (fallback: `roots/list`) to determine its workspace `W`;
- it asks the daemon for the **lead** session(s) projected for `W`
  ([002 §6](./002-runtime-delivery.md)) and surfaces their unread deliveries;
- this composes with the existing session-open flow: a `SessionStart` hook still calls
  `session open --host-session-id …`, so a real session record for `W` already exists for the
  channel server to find by workspace.

**Single-lead-session assumption.** When `W` has exactly one active lead session (the common case),
workspace binding is equivalent to session binding and unread/claimed accounting is exact. When `W`
has multiple concurrent lead sessions, the channel server **MUST** degrade rather than guess: it
surfaces the workspace's unread but **MUST NOT** claim on behalf of an ambiguous session; the
per-session hook-state transport (§3) remains the accurate surface in that case. The runtime can
detect the multi-lead condition because it tracks all sessions.

> **Open question (prototype).** `CLAUDE_PROJECT_DIR` availability and the spawned server's cwd are
> documented but not yet empirically confirmed for this host version, and the reference channels do
> not read them. The one-way prototype (G7) **MUST** verify both before this section is promoted from
> target to current.

### 4.5 Cross-transport deduplication

Both transports key off the same `session_event_state`. When the channel transport surfaces a
delivery it marks the underlying rows **claimed** (BP2), so the hook-state transport sees them
already claimed and suppresses the duplicate reminder. No new dedup mechanism is required — the
existing claimed state ([002 §7](./002-runtime-delivery.md)) is the dedup boundary across transports.

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

## 5. Availability & Fallback

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

## 6. Out of Scope

- **Permission relay** (`claude/channel/permission`, `notifications/claude/channel/permission_request`
  / `permission`): AgentMon is a work-signal system, not a tool-approval bridge. Not implemented, not
  planned here.
- **AgentMon as a consumer of inbound channel messages** (a "channel" source): channels push into a
  session, not into the daemon; this is not the integration's shape.

## 7. Examples

### 9.1 A high-urgency delivery rendered as a channel event

A settled high-urgency `file-fingerprint` claim surfaces as:

```text
<channel source="agentmonitors" monitor_id="build-config-drift" urgency="high"
         event_kind="mutation" object_key="/repo/package.json" event_id="01J…"
         event_count="1" lifecycle="turn-interruptible">
package.json changed — review whether build behavior or dependency state needs updating.
</channel>
```

**What this proves:** the same `DeliveryClaim` the hook path would surface is rendered into the
channel field schema; `event-kind` is carried as `event_kind`; `event_id` is available for the ack
tool.

### 9.2 Acknowledgement round-trip

1. The agent reads the `<channel … event_id="01J…">` tag and calls
   `agentmon_ack({ event_ids: ["01J…"] })`.
2. The server re-authorizes that `01J…` belongs to the bound workspace's session, then routes through
   the daemon's `events ack` path.
3. The event moves unread → acknowledged (SP4); the claim made by the push did **not** already
   acknowledge it (BP2).

**What this proves:** the two-way reply mechanism maps cleanly onto AgentMon's distinct
claimed-vs-acknowledged states.

## 8. Validation Implications

Transport and integration tests should be able to prove:

- a transport renders a `DeliveryClaim` without re-deriving delivery decisions (same events as the
  runtime emitted);
- surfacing via any transport marks rows claimed but not acknowledged (BP2);
- a channel push and the hook path do not double-surface the same event (cross-transport dedup, §4.5);
- meta keys are identifier-safe and values are tag-breakout-sanitized (§4.6);
- with the channel transport disabled/blocked, delivery still completes via the hook path with no
  error (§5);
- workspace binding resolves the correct lead session when `W` has one lead, and degrades (no
  ambiguous claim) when `W` has multiple leads (§4.4).

## 9. Open Questions

- Empirically confirm `CLAUDE_PROJECT_DIR` is populated for a spawned stdio MCP server and determine
  its cwd, via the one-way prototype (G7). Promote §4.4 from target to current only once verified.
- Decide whether the channel server should open a synthetic workspace-lead session when channels are
  used **without** the hook-driven `session open` flow, or require the hook flow as a precondition.
