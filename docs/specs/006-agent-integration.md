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
- resolves that socket the same per-workspace-aware way every other workspace-aware command does
  (`resolveManualDaemonSocketPath`, issue #335): an explicit `--socket` or `AGENTMONITORS_SOCKET`
  still wins outright, but otherwise an **enabled** workspace's persisted-or-derived per-workspace
  socket is used — not the bare global default (issue #358) — so a `session start`-lazy-booted
  daemon is reachable with the plugin's real, unmodified `.mcp.json` (no `--socket` flag);
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
  | `object_key`  | the event `objectKey`                                 | sanitized (§4.6)                   |
  | `event_id`    | the durable event ID                                  | passed back by the ack tool (§4.3) |
  | `event_count` | number of coalesced events, stringified               |                                    |
  | `lifecycle`   | `turn-interruptible` \| `turn-idle` \| `post-compact` |                                    |

The `source` attribute on the rendered `<channel>` tag is set by the host from the MCP server name
(e.g. `agentmonitors`), not by `meta`.

> **Stage-1 coverage.** The one-way server renders from a `DeliveryClaim`, whose
> `DeliveryEventSummary` carries `eventId`, `monitorId`, `urgency`, `body` (the raw monitor
> instructions), etc. but **not** `objectKey`. So stage 1 emits `lifecycle`, `mode`, `event_count`,
> `urgency`, and (for a single event) `monitor_id` and `event_id`. `object_key` is target and
> requires further enrichment; it is not yet emitted.

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
  and an explicit marker is appended:

  ```text
  [truncated — more monitor updates are pending; run `agentmonitors events list --unread` to see the rest]
  ```

  The final string including the marker is still ≤ 4000 chars. Truncation never drops a durable
  event: see §5.5 (unread-recoverability).

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
7. Call `claimDeliveryClient(sessionId, lifecycle, socket)`. If null → exit 0, print nothing.
8. Render via `renderHookDelivery(claim, hookEventName)`. If null (no event bodies and no reminder
   message) → exit 0, print nothing.
9. Write output and exit 0. The omitted/default format and `--format json` write compact hook wire
   JSON via `JSON.stringify(output)`. `--format text` writes only
   `output.hookSpecificOutput.additionalContext`.

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
   marker; then
3. **claims** exactly that many (`claimDelivery`'s `maxEvents`), so the deferred remainder is left
   **pending** (`first_notified_at` NULL) and re-delivers at the next context event.

Because claiming marks the underlying rows **claimed**, which is **not** acknowledgement (BP2 / SP4;
`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), every event — surfaced or
deferred — also **remains unread** and listable via `agentmonitors events list --unread` until
explicitly acknowledged.

The truncation marker (§5.1) is appended whenever the render omits any pending event — because a
whole block did not fit **or** because the transport deferred more high-urgency work — signposting
that more updates are pending. The single pathological case where one event's own block alone exceeds
the cap is shown partially (mid-truncated at a code-point boundary) to guarantee forward progress;
its full body stays unread and re-delivers.

The non-high branches need no sizing: `normal`/`low` reminders inject no per-event bodies, and the
`post-compact` recap re-shows all unread each time, so both self-heal. Uncapped callers (e.g. the
channel transport, whose surface is not length-bounded) omit `maxEvents` and claim the full delivered
set exactly as before.

No durable event is lost by truncation; the cap only bounds how much is injected into a single turn.

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
  **once** and, after registering, performs the post-compact recap **itself** (claims
  `post-compact` and prints the rendered `additionalContext` when there are unread events). The
  SessionStart hook runs the single command `agentmonitors session start`; there is no chained
  delivery. (This also avoids the parallel-execution race a two-entry form would have had.) The
  `UserPromptSubmit` and `SessionEnd` hooks are each their own invocation with their own stdin, so
  they remain single commands.

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
identical daemon-IPC client function the `events ack` CLI command calls (§4.3); its outbound push
routes through `claimDeliveryClient`, the identical function `hook deliver`/`hook claim` call (§5).
There is exactly one `events.ack` and one `hook.claim` IPC method on the daemon
([002 §10](./002-runtime-delivery.md)); every transport — hooks, CLI, or channel — drives the same
two calls. Disabling or stripping the MCP server therefore changes nothing about _what_ is
delivered, _when_, or _how_ urgency/lifecycle are honored (§6 above) — the only thing that changes
is which surface renders it: an `additionalContext` hook injection instead of a `<channel>` tag, and
an explicit `agentmonitors events ack` invocation instead of the in-session `agentmon_ack` tool call.

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
package.json changed — review whether build behavior or dependency state needs updating.
</channel>
```

**What this proves:** the same `DeliveryClaim` the hook path would surface is rendered into the
channel field schema; `event_id` is available for the ack tool.

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
- a channel push and the hook path do not double-surface the same event (cross-transport dedup, §4.5);
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
