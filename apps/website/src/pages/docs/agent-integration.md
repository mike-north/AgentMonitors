---
title: Agent Integration & Delivery
description: How a durable event actually reaches an agent session — hooks, the optional MCP channel, urgency timing, and running fully without MCP in restricted environments.
---

# Agent Integration & Delivery

[Core Concepts](/docs/concepts) covers how a monitor becomes a durable event. This page covers the
**last hop**: how that already-materialized event gets in front of an agent — the delivery
_transports_, exactly when each urgency level is surfaced, what the Claude Code plugin wires up
automatically, and — importantly for restricted corporate environments — that none of it requires
an MCP server.

## How delivery reaches a session

Once a monitor fires, the runtime turns the observation into a durable `monitor_events` row and
**projects** it into every matching **lead** session for that workspace (subagent sessions are
tracked but don't receive automatic deliveries). From there, delivery happens at one of three
**lifecycle points** — moments in the agent's turn where a transport can hand it pending work:

```
event materialized ──▶ projected into lead session(s) ──▶ delivery lifecycle point
                                                                 │
                                            ┌────────────────────┴────────────────────┐
                                            ▼                                          ▼
                                   hook-state transport                     MCP channel (optional)
                                   — the default, always available          — additive, never required
```

| Delivery lifecycle    | Fires at                                          |
| ---------------------- | -------------------------------------------------- |
| `turn-interruptible`   | Mid-session, at the next prompt/tool-use boundary |
| `turn-idle`            | After the current agent turn finishes             |
| `post-compact`         | Session start, as a recap of unread events        |

Claiming a delivery marks the underlying events **claimed** — it does not **acknowledge** them.
Acknowledgement (`agentmonitors events ack`, or the MCP `agentmon_ack` tool) is always a separate,
explicit step, so a claimed-but-unhandled event stays discoverable.

_Governing spec: [`docs/specs/002-runtime-delivery.md`](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md)
§6 (session projection), §7 (unread/claimed/acknowledged), §9 (delivery lifecycles)._

## Urgency: what's surfaced, and when

`urgency` (set in a monitor's frontmatter — see [Authoring monitors](/docs/authoring-monitors))
decides which lifecycle a monitor's events surface at, and how much detail is included:

| Urgency   | Surfaces at            | Timing                                                              | What's included                                             |
| --------- | ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `high`    | `turn-interruptible`   | After a **15 s settle window** — not instant                          | The concrete events: titles, summaries, and full body text  |
| `normal`  | `turn-interruptible`   | **Coalesced-until-ack**: one reminder for the whole unread batch, then silent until it's acknowledged | A reminder only — no per-event detail — naming the exact commands to run: `agentmonitors events list --session <id> --unread`, then `agentmonitors events ack --session <id>` |
| `low`     | `turn-idle`            | **Coalesced-until-ack**: one reminder for the whole unread batch, then silent until it's acknowledged | The same reminder as `normal` — no per-event detail |

Regardless of urgency, **every unread event is recapped at `post-compact`** (session start, after
a context compaction) with up to the 10 most recent events shown in full — titles, summaries, and
body text. This is the safety net: nothing that settles while an agent is away goes unseen forever.

The reminder-vs-detail split for `normal`/`low` matters in practice: a `normal` (or `low`) change
nudges the agent exactly **once** — a single coalesced reminder ("read the inbox") covering every
currently-unread event of that urgency — and then goes quiet. It does **not** re-nudge for each
additional `normal`/`low` event that arrives; the path only speaks again once the outstanding
events are acknowledged (`agentmonitors events ack`). The agent still has to go look
(`agentmonitors events list --unread`) to see what changed — the reminder never carries per-event
detail. Only `high` urgency injects the actual event content directly into the turn. If you want
the agent to react to specifics without acknowledging first, use `urgency: high`.

_Governing spec: 002 §9.1 (high), §9.2 (normal), §9.3 (low), §9.4 (recap)._

## What the Claude Code plugin automates (hooks)

Installing the `agentmonitors` Claude Code plugin wires the CLI into three lifecycle hooks — this
is the **hook-state transport**, the portable default that has no dependency beyond Claude Code's
own hook mechanism:

| Hook event         | Command                       | Purpose                                                          |
| ------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `SessionStart`      | `agentmonitors session start` | Boots the per-workspace daemon, registers the session, and surfaces the `post-compact` recap |
| `UserPromptSubmit`  | `agentmonitors hook deliver`  | The primary mid-session delivery point (`turn-interruptible`)    |
| `SessionEnd`        | `agentmonitors session end`   | Deregisters the session so an idle daemon can reap itself         |

Each command is guarded so an environment without the `agentmonitors` binary on `PATH` degrades to
a silent no-op (with a one-time onboarding hint on `SessionStart`) rather than a visible error on
every prompt.

_Governing spec: [`docs/specs/006-agent-integration.md`](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/006-agent-integration.md)
§3 (hook-state transport), §5 (the `hook deliver` wire contract), §5.6 (plugin activation packaging)._

## What the optional MCP channel adds

The plugin also ships an MCP server (`agentmonitors channel serve`, wired via the plugin's
`.mcp.json`) that pushes the same deliveries into the session as `<channel>` tags, and exposes an
`agentmon_ack` tool so the agent can acknowledge events without leaving the conversation.

**The channel changes the surface, not the semantics.** It consumes the exact same
`DeliveryClaim` the hook path would have surfaced, at the same urgency and lifecycle timing, and
marks the same rows claimed. The one genuinely new capability is the **in-session acknowledgement
affordance** — calling a tool instead of running a CLI command. Nothing about *what* is delivered
or *when* changes.

The channel is also **research-preview and gated**: it requires Claude Code v2.1.80+, and on
Team/Enterprise plans an admin must enable channels and allowlist the server. This is exactly why
it's built as an addition, never a dependency — see the next section.

_Governing spec: 006 §4 (channel mechanism, notification schema, the `agentmon_ack` tool), §6
(availability & the additive-only invariant)._

## Restricted environments: operating without MCP

**MCP is never required.** This is a spec invariant (006 §6, "NP-CH"), not an incidental gap:
every capability — delivery, acknowledgement, and status — is reachable through hooks and the CLI
over the same daemon connection the channel itself uses. A hooks-only deployment is a fully
supported, first-class configuration, not a degraded fallback.

**What to do differently: usually nothing.** The hook-state transport (`SessionStart` /
`UserPromptSubmit` / `SessionEnd`, above) works standalone. If your environment specifically blocks
unblessed MCP servers, remove or block the plugin's `.mcp.json` (e.g. via your Claude Code MCP
server allowlist/denylist) and keep the `hooks/hooks.json` half installed — every other capability
is unaffected.

The only thing that actually changes is which surface you use for the in-session acknowledgement
tool call:

| Capability                         | With the MCP channel enabled                         | Hooks-only (CLI equivalent)                                          |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Mid-session delivery                | `<channel source="agentmonitors" ...>` push          | `agentmonitors hook deliver` (already wired to `UserPromptSubmit`)     |
| Acknowledge events                  | `agentmon_ack({ event_ids: [...] })` tool call         | `agentmonitors events ack --session <id> --event-ids <id1>,<id2>`       |
| Acknowledge everything unread       | `agentmon_ack({})` (omit `event_ids`)                 | `agentmonitors events ack --session <id>` (omit `--event-ids`)         |
| Inspect what's pending              | Reading the rendered `<channel>` tag                  | `agentmonitors events list --session <id> --unread`                     |

`--event-ids` takes a **comma-separated** list, e.g. `--event-ids 01J...A,01J...B` — it is split on
`,` (and each id trimmed), so space-separated ids (`--event-ids 01J...A 01J...B`) are **not**
recognized as two ids.

Both columns drive the **identical daemon IPC calls** (`hook.claim`, `events.ack`) — the channel is
a thin push/ack front-end over the same connection the CLI uses, so there is no capability gap, only
a different surface.

Copy-runnable, once a session is registered (see
[Notify your agent when a file changes](/docs/notify-when-a-file-changes) for how to register one):

```bash
# find the session id
agentmonitors session list --format json

# see what's pending, without touching MCP
agentmonitors events list --session <session-id> --unread

# acknowledge everything unread
agentmonitors events ack --session <session-id>

# confirm it cleared
agentmonitors events list --session <session-id> --unread
```

_Governing spec: 006 §2 (the transport seam — every transport drives the same daemon IPC, never
re-deriving delivery decisions), §6 (availability & fallback, NP-CH)._

## Host support today

| Host                        | Authoring, validation, daemon, CLI (`events`, `hook`, `session`) | Automatic in-session delivery (hooks / channel) |
| ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| **Claude Code** (CLI/desktop) | Shipped                                                              | **Shipped** — this page                            |
| **Codex** (CLI/desktop)      | Works today — monitors are plain markdown and the CLI is host-agnostic | On the roadmap — not yet wired                    |
| **Cursor** (CLI/IDE)         | Works today — same reason                                            | On the roadmap — not yet wired                    |

AgentMonitors' core — `MONITOR.md` authoring, `agentmonitors validate`, the daemon, and the
`events`/`hook`/`session` CLI surface — has no Claude-specific dependency, so you can author and
verify monitors under any host today. What's host-specific is the **adapter** that maps a host's
own lifecycle events to AgentMon's delivery lifecycles (and, optionally, a native push surface like
the Claude Code channel). That adapter ships today only for Claude Code; Codex and Cursor adapters
are named, scoped **target** work with a defined contract each future adapter must satisfy — not
yet implemented, and not overstated as available.

_Governing spec: 006 §11 (the multi-host adapter matrix, target status; see §11.1 for the contract
every future host adapter must satisfy)._

## Learn more

- [Notify your agent when a file changes](/docs/notify-when-a-file-changes) — the end-to-end
  walkthrough that registers a session and drives the exact hook payloads described above
- [Authoring monitors](/docs/authoring-monitors) — the `urgency` field and everything else in
  frontmatter
- [Core Concepts](/docs/concepts) — how an observation becomes a durable event in the first place
