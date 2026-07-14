---
title: Troubleshooting
description: Symptom-first fixes for monitors that don't fire, don't notify, or stop working — walk the same verdict stages agentmonitors monitor explain uses.
---

# Troubleshooting

Start with `agentmonitors monitor explain <id>` for almost every "it's not working" report — it
walks one monitor's signal through the whole pipeline and names the exact stage where it stopped,
so you never have to guess:

```bash
agentmonitors monitor explain watch-file --dir .claude/monitors --format text
```

The five symptoms below cover the situations `explain` alone doesn't fully resolve.

## My monitor never fires

`monitor explain` reports six stages, in pipeline order, each with a status glyph — `✓` ok,
`○` healthy (idle is not a bug), `⏳` pending (intentionally holding), `✗` failure — followed by a
**verdict** naming the stage where the signal actually stopped:

```
Monitor watch-file
✓ Definition: Monitor definition is valid.
✓ Scheduling: Last tick completed at 2026-07-12T20:55:32.000Z; next due 2026-07-12T20:55:37.000Z.
○ Observation: Source ran, observed 0 changes — your watched target genuinely hasn't changed (not a bug).
✓ Notify state: No debounce, rollup, or throttle hold is currently active.
✓ Materialization: 1 recent monitor_events row(s) found.
✓ Projection and delivery: Events are projected to lead sessions (claimed: 1).
Verdict: healthy at Observation - Source ran, observed 0 changes — your watched target genuinely hasn't changed (not a bug).
```

Read the verdict stage, not just its glyph:

1. **Definition failure** — a parse or schema error in `MONITOR.md`. Fix it, then confirm with
   `agentmonitors validate .claude/monitors`. Example:

   ```
   ✗ Definition: Monitor definition is invalid: scope: Instance does not have required property "globs".
   ```

2. **Scheduling** — the daemon isn't running yet, or the monitor isn't due. If nothing has ever
   ticked, see [Project not enabled](#project-not-enabled) below; otherwise wait for the reported
   `nextDueAt`.

3. **Observation** — `healthy` (`○`) with "0 changes" is the expected idle state, not a bug. A
   `failure` here means the source itself errored — a bad glob, unreachable URL, or failing
   command. Isolate it with a source-only dry run, which needs no daemon or database:

   ```bash
   agentmonitors monitor test .claude/monitors/watch-file/MONITOR.md
   ```

   ```
   Error: No files matched this monitor's globs. Check watch.globs and watch.cwd relative to workspace: /path/to/project
   ```

4. **Notify state** — `pending` (`⏳`) means a `debounce`/`throttle`/`rollup` hold is intentionally
   suppressing delivery. This is normal, not stuck:

   ```
   ⏳ Notify state: debounce is holding 1 observation(s) until 2026-07-12T21:17:29.880Z.
   ⏳ Materialization: No monitor_events rows yet — the notify layer is holding the batch until the debounce settle window elapses.
   ⏳ Projection and delivery: Delivery has not started because no event has materialized yet.
   Verdict: pending at Notify state - debounce is holding 1 observation(s) until 2026-07-12T21:17:29.880Z.
   ```

   Re-run `explain` after the reported time passes.

5. **Materialization failure** — the source triggered but no durable event was written. This is
   rare; check the daemon's own logs (`agentmonitors daemon run` output) for a tick-level error.

6. **Delivery pending/failure** — an event exists but nothing was projected to a session in this
   workspace yet. Continue to the next section.

**Traces to:** [002 §10.7](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#107-monitor-pipeline-diagnosis)
(monitor pipeline diagnosis, stage statuses) and
[005 `monitor explain`](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/005-cli-reference.md#monitor-explain--pipeline-diagnosis).

## It fired but my agent wasn't told

A **materialized** event and a **delivered** notification are not the same thing — `explain` can
report `materialization: ok` while the agent's turn never saw anything, because delivery tracks
three distinct, separately-advancing states per session:

| State | Meaning |
|---|---|
| **Unread** | Not yet acknowledged. The default state for every new event. |
| **Claimed** | Surfaced at least once at a delivery lifecycle (a turn boundary). Claiming is **not** the same as reading it — a claimed event can still need attention. |
| **Acknowledged** | Explicitly marked read (`agentmonitors events ack`). |

`monitor explain`'s delivery verdict reflects the daemon's session-state model and can be stale
relative to what a session actually has pending. The **authoritative check** is `events list`:

```bash
agentmonitors session list --format text
# <agentmon-session-id>  active  <host-session-id>  <workspace-path>

agentmonitors events list --session <agentmon-session-id> --unread
```

Non-empty output confirms the event reached the session and is pending delivery, regardless of
what `explain` showed. If `events list --unread` is **also** empty, work through these before
assuming the event is lost:

- **Workspace path mismatch.** Events project only into sessions whose `workspacePath` matches
  **exactly**, byte-for-byte — there is no path normalization. A path resolved through a symlink
  (e.g. `/private/tmp/...` from Node's `process.cwd()`) will **not** match the same directory typed
  literally (`/tmp/...`). Always pass the identical `cwd` value to every command in a sequence —
  don't mix an explicit `--workspace` flag on one command with the default on another.
- **Urgency vs. delivery point.** Only settled `high`-urgency events inject a body into the current
  turn (`turn-interruptible`, after a 15 s settle window). `normal` events surface as a coalesced
  reminder at turn boundaries and `low` events only when the session is idle; full bodies for both
  arrive in the recap emitted at `post-compact` — which fires within the **same** session after a
  context compaction, not only when a new session starts. Check the event's `urgency` field before
  concluding delivery is broken.

Confirm the actual transport with the real hook command:

```bash
printf '{"session_id":"<host-session-id>","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
```

A non-empty `additionalContext` in the printed JSON is exactly what the agent would receive.
Empty output means either nothing is pending **or** the invocation is misconfigured — those two
cases are indistinguishable without diagnosis. Append `--debug` to the same command to see which:
it writes a step-by-step diagnosis to stderr (session resolution, workspace/socket state,
pending-event counts by urgency, and the hold reason for anything not yet deliverable) while
leaving stdout untouched.

```bash
printf '{"session_id":"<host-session-id>","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver --debug
```

**Traces to:** [002 §6](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#6-session-projection)
(session projection, exact-match workspace filtering), [002 §7](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#7-unread-claimed-and-acknowledged)
(unread/claimed/acknowledged), [002 §9](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#9-delivery-lifecycles)
(delivery lifecycles), and [002 §10.7](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#107-monitor-pipeline-diagnosis)
(`explain` vs. `events list` disagreement).

## It worked once then stopped

A few explanations to rule out before assuming the monitor broke:

**1. The daemon idle-reaped.** A daemon booted by `session start` stops itself once it has had
**zero active sessions for `--reap-after-ms`** continuously (default 5 minutes). If the session
that started it ended, the daemon shuts down — and stays down until the next `session start`
reboots it. Nothing is lost; it just wasn't running to observe changes in the gap. Confirm with:

```bash
agentmonitors daemon status --socket <socket-from-agentmonitors.local.md>
# Daemon running: no
```

The fix is simply the next `session start` call.

**2. The settle window delays delivery — it doesn't skip it.** `high` urgency defaults to a 15 s
debounce settle; a monitor's own `notify.settle-for` can be longer still. A change that landed
seconds ago legitimately hasn't been delivered yet. Wait out the reported settle time (visible in
`explain`'s notify-state stage above) before concluding delivery stopped.

**3. `command-poll`, `api-poll`, and `file-fingerprint` use baseline-then-detect.** The **first**
observation after a daemon restart, or after a monitor is newly picked up, only establishes a
fresh baseline — a baseline observation cannot itself be a fire. A **second** tick against that
baseline is required to detect a change. If the daemon (re)started recently and you triggered the
change before its first tick ran, that tick baselines instead of firing; the following tick
detects it.

**Traces to:** [002 §10.2](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server)
(idle reaping, lazy boot) and [002 §4.1](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#41-default-notify-behavior)
(default notify/settle behavior); the `command-poll` baseline-then-detect recipe in the
[`setup-monitors` skill's Verify It Fires section](https://github.com/mike-north/AgentMonitors/blob/main/agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md#verify-it-fires).

## Project not enabled

Symptom: nothing ever happens — no daemon ever starts, hooks stay silent, and
`agentmonitors monitor explain` reports it has **no daemon running and no persisted state to
show** (nothing has ever ticked, so there is no pipeline state to explain yet).

Root cause: `agentmonitors session start` **quick-exits** — without registering a session or
booting a daemon — whenever `.claude/agentmonitors.local.md` is absent, or present with `enabled`
unset or `false`. This is deliberate: Agent Monitors never activates in a project without explicit
opt-in.

Fix — create `.claude/agentmonitors.local.md`:

```markdown
---
enabled: true
---
```

and add `.claude/*.local.*` and `/.agentmonitors/` to `.gitignore` (both are regenerated, safe to
delete — the latter is the daemon's per-session runtime-state directory, created the moment a
session opens). `agentmonitors init` ignores both for you automatically.

**Claude Code now tells you this automatically.** If `.claude/monitors/` already has one or more
monitor definitions and the project is not yet enabled, `SessionStart` emits a one-line advisory
naming the count and the exact enable step, instead of staying silent. You can reproduce the same
hook call directly:

```bash
printf '{"session_id":"verify-1","cwd":"%s","hook_event_name":"SessionStart"}' "$PWD" \
  | agentmonitors session start
```

```json
{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentMon: monitoring is disabled for this project (1 monitor definition found under .claude/monitors/, but none of them are being watched). To enable it, create `.claude/agentmonitors.local.md` in this project with `enabled: true`."}}
```

A project with **zero** monitor definitions stays fully silent either way — the advisory fires only
when something is sitting unwatched.

**Traces to:** [002 §10.2](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server)
("Quick-exit when not enabled") and [006 §5.6](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/006-agent-integration.md#56-activation-packaging-the-agentmonitors-plugin)
("Monitors-found-but-disabled advisory").

## Which session ID do I use

Two different IDs exist, and commands are not interchangeable about which one they expect:

| ID | What it is | Where it comes from | Used by |
|---|---|---|---|
| **Host session id** | Claude Code's own session identifier | the `session_id` field in every hook's stdin JSON payload | `session start` / `session end` / `hook deliver` — read from **stdin**, never passed as a flag |
| **AgentMon session id** | A ULID Agent Monitors assigns internally when a session opens | printed by `session open`/`session list` | `--session` on `events list` / `events ack` |

```bash
agentmonitors session list --format text
# <agentmon-session-id>  active  <host-session-id>  <workspace-path>
```

Use the **AgentMon id** (first column) for `--session` on `events list`/`events ack`. Use the
**host session id** only inside a hook JSON payload piped to `session start`, `session end`, or
`hook deliver` — there is no `CLAUDE_CODE_SESSION_ID` environment variable to fall back on; it
must come from stdin.

**Traces to:** [005 §10](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/005-cli-reference.md#10-session--manage-agent-sessions)
(`session` command reference) and [006 §5.0](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/006-agent-integration.md#50-input-contract-stdin-json)
(hook input contract).

## Next steps

- [Notify your agent when a file changes](/docs/notify-when-a-file-changes) — the verified
  end-to-end delivery recipe these commands are drawn from
- [Authoring monitors](/docs/authoring-monitors) — the enable-and-verify-delivery recipe, all
  sources, urgency levels, and notify strategies
- [CLI reference](/docs/cli-reference) — every command referenced above, its flags, and output
  formats
- [Use cases](/docs/use-cases) — patterns from simple file-watching to fleet supervision
