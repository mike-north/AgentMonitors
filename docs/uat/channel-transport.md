# UAT Recipe: MCP Channel Transport

The MCP **channel** transport ([006 §4](../specs/006-agent-integration.md)) is a Claude Code
research-preview feature and cannot run in CI — there is no way to spawn a real Claude Code host in
a headless test runner, and channels may be org-disabled entirely (006 §6). It is therefore gated
on **manual UAT**: a human (or an agent with a real Claude Code session) runs this recipe and
records the result below. Run this recipe before treating the channel path as regression-safe, and
whenever `apps/cli/src/commands/channel.ts`, `apps/cli/src/channel-ack.ts`,
`apps/cli/src/channel-render.ts`, or the plugin's [`.mcp.json`](../../agent-plugins/agentmonitors/.mcp.json)
change.

This complements, but does not replace, the automated coverage that already exists:

- `experiments/channel-uat` drives a real `channel serve` process against a real daemon with the
  real MCP SDK client, proving the push mechanism itself works end to end — but it plays the role
  of the MCP host, not a real Claude Code session, and never exercises the agent actually reading a
  rendered `<channel>` tag or calling `agentmon_ack` as a tool.
- `experiments/channel-probe` established the session/workspace-binding signals (006 §4.4) a real
  Claude Code host provides to a spawned channel server.
- `apps/cli/src/commands/channel-hooks-ipc-parity.test.ts` proves (statically) that the channel's
  push/ack code paths call the exact same daemon-IPC client functions the hooks-only path uses.
- `apps/cli/src/commands/cli.integration.test.ts`'s `channel serve workspace-socket resolution
(issue #358)` suite promotes the `experiments/channel-uat` pattern into CI: it lazy-boots a daemon
  via the real `session start` stdin contract, then spawns `channel serve` with no `--socket` flag
  and no `AGENTMONITORS_SOCKET` — exactly as the plugin's `.mcp.json` does — and asserts the push
  arrives, proving the socket-resolution fix itself (though still not a real Claude Code session).

None of the above puts a real agent in a real session reading a real `<channel>` tag and calling a
real tool — that gap is what this recipe covers.

## Historical issue, now fixed (issue #358)

**Between 2026-07-15 and this fix, `channel serve` — spawned exactly as the plugin's `.mcp.json`
spawns it, with no `--socket` flag — did not resolve the same per-workspace socket a `session
start`-lazy-booted daemon binds to for an enabled project.** It fell back to the stale
global-default socket, found no daemon there, and the `<channel>` push silently never arrived, even
though the event was correctly materialized and delivered via the hook-state transport. This was
discovered while drafting this recipe (root cause, repro, and suggested fix: issue #358) and was
**not** a defect in the channel mechanism itself — a `channel serve` process pointed at the correct
socket always behaved exactly as specified (confirmed with an explicit `--socket` control run).

**As of this fix, `channel serve` resolves the same per-workspace socket `session start` binds to**
(parity with `resolveManualDaemonSocketPath`, the resolution every other workspace-aware command
already used — issue #335), so the plugin's real, unmodified `.mcp.json` (no `--socket` flag) works
with zero extra configuration. **Step 3's pre-seed workaround is no longer required** — skip it for
a clean run with the plugin's default configuration, which is the way to confirm the fix; per the
recipe's own guidance it remains harmless to keep applied if you already have it scripted.

## What this recipe proves

| Recipe step(s)          | Proves                                                                                                                                                                           | Governing spec                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1–6 (setup)             | A monitor fires and materializes a durable event in a real, plugin-installed session                                                                                             | [002 §§1–9](../specs/002-runtime-delivery.md) |
| 7–9 (channel push)      | The channel server pushes a `<channel source="agentmonitors" ...>` event carrying the field schema in [006 §4.2](../specs/006-agent-integration.md#42-notification-field-schema) | 006 §4.1–§4.2                                 |
| 10 (dedup)              | The same event is **not** re-delivered via the hook path after the channel already claimed it                                                                                    | 006 §4.5                                      |
| 11–12 (ack)             | `agentmon_ack` acknowledges the event in-session and `events list` reflects the acknowledged state                                                                               | 006 §4.3                                      |
| 13–16 (blocked channel) | With the MCP server disabled, hook delivery still occurs and the channel's absence is a silent no-op                                                                             | 006 §6 / NP-CH                                |

## Prerequisites

1. **Claude Code v2.1.80+.** Channels are research preview and version-gated (006 §6). If the
   channel never appears to load (see the failure-mode note in step 5), consult
   <https://code.claude.com/docs/en/channels-reference.md> and
   <https://code.claude.com/docs/en/mcp.md> for your Claude Code version's current channel/MCP
   enablement surface — Claude Code's own settings for this are outside this repo's control and may
   have moved since this recipe was written. On a Team/Enterprise plan, an admin must enable
   channels and allowlist this server, or you must launch with a development-channels flag (006
   §6; `experiments/channel-probe/README.md` shows this flag in use for its own throwaway probe
   channel).
2. **The `agentmonitors` CLI installed and on `PATH`.** `npm i -g agentmonitors`, then confirm with
   `agentmonitors --help`.
3. **The `agentmonitors` Claude Code plugin installed.** From inside Claude Code:
   ```text
   /plugin marketplace add mike-north/AgentMonitors
   /plugin install agentmonitors@agentmonitors
   ```
   This installs the hooks (`hooks/hooks.json`) **and** the channel MCP (`.mcp.json`) together —
   there is no separate "channel only" install.
4. **A disposable test project.** An empty directory is fine; this recipe creates
   `.claude/agentmonitors.local.md` and `.claude/monitors/`. Do not run it against a repo you care
   about — steps 13–16 below intentionally toggle the channel off for this project.

## Setup

Run these from a shell, **before** opening Claude Code in the test project.

**1. Create the project and enable monitoring:**

```bash
mkdir -p ~/am-channel-uat/.claude/monitors/watch-file
cd ~/am-channel-uat
cat > .claude/agentmonitors.local.md << 'EOF'
---
enabled: true
---
EOF
echo "hello" > watched.txt
```

**2. Author a fast, high-urgency test monitor** (short `interval`/`settle-for` so the recipe
doesn't take the default ~30s + 15s to detect — see
[the setup-monitors skill's fast-test guidance](../../agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md#fast-test-setup-shorten-intervals-before-verifying)).
`urgency: high` is required — only `high` injects a concrete event body mid-session (006 §5.4 /
[agent-integration.md](../../apps/website/src/pages/docs/agent-integration.md)):

```bash
cat > .claude/monitors/watch-file/MONITOR.md << 'EOF'
---
name: Watch file
watch:
  type: file-fingerprint
  globs:
    - 'watched.txt'
  interval: 5s
notify:
  strategy: debounce
  settle-for: 5s
urgency: high
---

watched.txt changed. Review what changed.
EOF
agentmonitors validate .claude/monitors
```

Expect `Valid monitors: 1`.

**3. (Optional, historical) Apply the now-unneeded #358 workaround** — #358 has shipped, so
`channel serve` resolves the correct socket by default; skip this step for a clean run that
confirms the fix with zero configuration. Leaving it in place is still harmless if you already have
it scripted:

```bash
SOCK="/tmp/agentmon-channel-uat-$$.sock"
DB="/tmp/agentmon-channel-uat-$$.db"
cat > .claude/agentmonitors.local.md << EOF
---
enabled: true
socket: $SOCK
db: $DB
---
EOF
export AGENTMONITORS_SOCKET="$SOCK"
```

`session start` reads the `socket:`/`db:` fields straight out of `.claude/agentmonitors.local.md`
(so its lazily-booted daemon binds to `$SOCK`); `channel serve` reads `AGENTMONITORS_SOCKET` from
its inherited environment (Claude Code passes its own process environment through to spawned MCP
servers, on top of the `CLAUDE_PROJECT_DIR`/`CLAUDE_CODE_SESSION_ID` it injects — 006 §4.4), so both
now agree on `$SOCK` without editing the plugin's `.mcp.json`. **Launch Claude Code from this same
shell** (the one that just ran `export`) so the environment variable is inherited.

**4. Open a real Claude Code session in this project:**

```bash
claude
```

This fires the `SessionStart` hook (`agentmonitors session start`), which lazy-boots the daemon at
`$SOCK` and registers the session (006 §5.6). It also causes Claude Code to spawn the plugin's
`.mcp.json` MCP server (`agentmonitors channel serve`) for this session.

**Expected observation:** no error banner from Claude Code about a failing plugin or hook. Since the
project has exactly one, already-enabled monitor, there is no "monitoring disabled" advisory
(§5.6) — a fresh session with nothing yet pending produces no visible `SessionStart` output.

**Failure mode:** if Claude Code reports the plugin failed to load, re-check step 3 (marketplace
add + install) and that `agentmonitors` is genuinely on `PATH` inside Claude Code's own shell
environment (`command -v agentmonitors`).

## Part A — push, dedup, and acknowledgement

**5. Confirm the channel is active for this session.** Ask Claude (or use Claude Code's own MCP
status surface) to confirm the `agentmonitors` MCP server is connected for this session.

**Expected observation:** the server is listed and connected — no "blocked by org policy" or
connection-error state.

**Failure mode:** if it's absent or blocked, this is a prerequisites gap (step 1), not a bug in this
recipe — capture whatever diagnostic Claude Code surfaces (its own MCP-server error/log detail) and
consult the channels-reference/mcp docs linked in Prerequisites.

**6. Trigger the watched change.** From inside the session, ask Claude to run:

```bash
printf '\nchange %s\n' "$(date +%s)" >> watched.txt
```

(Or make the change yourself in another terminal in the same directory — either is observed
identically by the daemon.)

**7. Wait for detect + settle**, then verify the event materialized. Ask Claude to run (or run
yourself, from the project directory — the persisted `.claude/agentmonitors.local.md` from step 3
makes this resolve the same socket with no flags needed):

```bash
agentmonitors session list --format text
# <agentmon-session-id>  active  <host-session-id>  <path-to-project>

sleep 15   # interval(5s) + settle-for(5s) + margin
agentmonitors events list --session <agentmon-session-id> --unread
```

**Expected observation:** one row for `watch-file`, urgency `high`, `deliveryState: unread` (not yet
claimed by anything). Note its `createdAt` — you need it for the next step's math. If empty, wait a
few more seconds and re-run — do not re-trigger step 6.

**8. Wait for the (separate, additional) high-urgency claim-settle window, then observe the
`<channel>` push in-session.** A settled-event **claim** is gated by its own fixed ~15s window
measured from the event's `createdAt` (`DEFAULT_HIGH_URGENCY_SETTLE_MS`,
[006 §9.1](../specs/006-agent-integration.md#91-a-high-urgency-delivery-rendered-as-a-channel-event)
— "After a 15 s settle window — not instant") — this is **on top of**, not the same as, the
monitor's own `notify.settle-for` from step 2. Since step 7 already confirmed materialization at
roughly `trigger + 10s`, allow at least another **15s** (five polls at the channel's default 3s
cadence, [005 §13](../specs/005-cli-reference.md)) — i.e. **~25–30s total from step 6** — before
expecting the push. No action is required from you: the channel server pushes automatically. Ask
Claude to quote the exact `<channel source="agentmonitors" ...>` tag it received (or, if you are
the agent running this recipe yourself, read it directly out of your own context — this is the
identical mechanism that delivers this repo's own `agentmonitors` monitors into a live session).

**Expected observation**, matching 006 §4.2/§9.1 exactly for a single settled high-urgency event
(the sole watched file, so `event_count="1"`; `object_key` is not yet emitted — 006 §4.2
"Stage-1 coverage" note):

```text
<channel source="agentmonitors" monitor_id="watch-file" urgency="high"
         event_id="<ULID>" event_count="1" lifecycle="turn-interruptible">
1. File changed: <absolute-path-to>/watched.txt
</channel>
```

Note the `event_id` — you need it for step 11 (or omit it there to ack all unread).

**Failure mode:** nothing arrives 30s past the event's `createdAt` from step 7 (ten polls). First
re-check step 7's `events list` output — if the event is not even `unread` there, this is a
materialization/delivery problem, not a channel problem (see [Failure capture](#failure-capture)
below). If the event **is** unread but no `<channel>` tag ever appears well past the ~25–30s total
window, and step 3's workaround is applied, first confirm you launched `claude` from the same shell
that exported `AGENTMONITORS_SOCKET`; if the workaround is **not** applied and this still happens,
that is a genuine channel-transport regression (not the fixed #358) — capture the diagnostics in
[Failure capture](#failure-capture) before filing.

**9. Confirm the underlying rows are `claimed`, not `acknowledged`, by the push alone (BP2).** From
the project directory:

```bash
agentmonitors events list --session <agentmon-session-id> --unread
```

**Expected observation:** the same event is still present (`--unread` matches unacknowledged, which
includes claimed) but now shows `"deliveryState": "claimed"` — the push surfaced it without
acknowledging it (006 §2, "MUST NOT acknowledge").

**10. Verify cross-transport dedup (006 §4.5).** Ask Claude to replay the exact `UserPromptSubmit`
hook payload Claude Code itself would send, reusing the host session id from step 7:

```bash
printf '{"session_id":"<host-session-id>","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
```

**Expected observation:** **completely empty stdout.** The event the channel already claimed is
excluded from a fresh `turn-interruptible` claim (the runtime's `pendingEventsForSession` only
considers rows with no `first_notified_at` yet — 006 §4.5's "the existing claimed state is the
dedup boundary"), and with no other unread `normal`/`low` events in this minimal test project there
is nothing else to report. Any non-empty output here (in particular, the file's title/body
reappearing) is a dedup regression — capture the full JSON output and `agentmonitors monitor
explain watch-file --dir .claude/monitors --format text` before filing.

**11. Acknowledge via the in-session tool.** Ask Claude to call the `agentmon_ack` tool with the
`event_id` from step 8 (or with no arguments, to acknowledge all unread):

> Call `agentmon_ack` with `event_ids: ["<event_id from step 8>"]`.

**Expected observation:** Claude Code's transcript shows the `agentmon_ack` tool call and its
result text — `"Requested acknowledgement of 1 event(s); ids not projected to this session are
ignored."` for an explicit id, or `"Acknowledged all unread events for this session."` for the
no-argument form (`apps/cli/src/commands/channel.ts`).

**12. Verify the acknowledged state via the CLI (the authoritative check).**

```bash
agentmonitors events list --session <agentmon-session-id> --unread
```

**Expected observation:** empty — `--unread` filters on `acknowledgedAt IS NULL`, and the event's
`acknowledgedAt` is now set. If you want to see the row itself with its new state, drop `--unread`:

```bash
agentmonitors events list --session <agentmon-session-id>
# same event, now "deliveryState": "acknowledged"
```

**Failure mode:** if `events list --session ... --unread` still shows the event, capture the exact
`agentmon_ack` tool-call arguments and result text from step 11 (a stale/incorrect `event_id`, or a
session-id mismatch causing the daemon's "outbound gate" re-authorization to silently drop the id —
006 §4.3 — are the two most likely causes) alongside `agentmonitors monitor explain watch-file
--dir .claude/monitors --format text`.

## Part B — blocked channel (hooks-only fallback, 006 §6 / NP-CH)

This part proves that disabling the MCP server changes only the delivery **surface**, never the
delivery **semantics** — hook-state delivery keeps working, and the channel's absence produces no
visible error anywhere (NP-CH: "if the channel is not loaded or is blocked... AgentMon MUST NOT
surface an error").

**13. Disable the channel MCP server for this project, keeping the hooks half installed.** Two
options, in order of preference — which one is available depends on your Claude Code version:

- **Per-session MCP disable (preferred if available):** use Claude Code's own MCP server
  management surface to disable just the `agentmonitors` server for this session, leaving the
  plugin's hooks active. Consult <https://code.claude.com/docs/en/mcp.md> for the current mechanism
  in your version.
- **Local plugin copy without `.mcp.json` (always available, fully repo-grounded):** clone
  [`agent-plugins/agentmonitors`](../../agent-plugins/agentmonitors) locally, delete its
  `.mcp.json`, and install that local copy as a marketplace instead of the published one — this is
  exactly the "hooks-only" configuration [the plugin's own README](../../agent-plugins/agentmonitors/README.md#running-hooks-only-no-mcp)
  documents for restricted environments. `hooks/hooks.json` is unaffected either way.

Restart the Claude Code session in the project after applying either option, so the new MCP
configuration takes effect.

**Expected observation:** the session starts with **no error, warning, or degraded-mode banner**
about the missing channel — this is the silent-no-op guarantee itself (NP-CH). If you are using
Claude Code's own MCP surface, `agentmonitors` should simply not appear as a connected channel (or
appear disabled), with nothing else in the transcript calling attention to it.

**14. Trigger a second change and let it fully settle.** `hook deliver`'s `UserPromptSubmit` claim
uses the exact same `turn-interruptible` high-urgency claim path as the channel push (step 8) — the
monitor's `notify.settle-for` (5s) plus the fixed, additional ~15s claim-settle window
(006 §9.1), so allow the same ~25–30s total, not just the notify settle:

```bash
printf '\nsecond change %s\n' "$(date +%s)" >> watched.txt
sleep 28
```

**15. Confirm delivery still happens via the hook path.** From the project directory (or ask Claude
to run this):

```bash
printf '{"session_id":"<host-session-id>","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
```

**Expected observation:** a non-empty JSON object whose `hookSpecificOutput.additionalContext`
names `watch-file` and the file change — the identical content shape the channel would have carried,
just via `additionalContext` instead of a `<channel>` tag (006 §6.1's capability-parity table). If
empty, wait a few more seconds and retry — do not re-trigger step 14.

**16. Confirm no error surfaced anywhere in this whole sequence.** Check Claude Code's own
transcript/logs for any MCP-connection error referencing `agentmonitors`, and re-run:

```bash
agentmonitors daemon status --format json
```

**Expected observation:** `"running": true`, a nonzero session/event count, no anomaly — the daemon
and hook-state transport are completely unaffected by the missing channel.

## Failure capture

When a step doesn't match its expected observation, capture these before filing:

- **`agentmonitors monitor explain watch-file --dir .claude/monitors --format text`** — needs no
  daemon (reads persisted state from disk) and names the exact pipeline stage
  (definition/scheduling/observation/notify/materialization/delivery) where the signal stopped
  ([troubleshooting.md](../../apps/website/src/pages/docs/troubleshooting.md)).
- **`agentmonitors daemon status --format json`** — confirms whether a daemon is even running and
  at which socket, and how many sessions/events it knows about.
- **`agentmonitors hook deliver --debug`** (fed the same stdin payload) — writes a step-by-step
  diagnosis to stderr naming which resolution step held or failed (005 §12.2.1), without touching
  stdout.
- **Daemon log — with a real caveat.** A `session start`-lazy-booted daemon runs fully detached
  with `stdio: 'ignore'` (`apps/cli/src/detached-spawn.ts`) — there is **no daemon log to tail** in
  the normal plugin flow. If you need live daemon stderr (e.g. a `AgentMon runtime tick failed: …`
  line, [002 §9.2](../specs/002-runtime-delivery.md)), stop the lazy daemon
  (`agentmonitors daemon stop`) and restart it by hand in a visible terminal, pointed at the exact
  same persisted socket/db from `.claude/agentmonitors.local.md`:
  ```bash
  agentmonitors daemon run .claude/monitors --socket "$SOCK" --reap-after-ms 0 --poll-ms 5000
  ```
  The next `session start` (e.g. a fresh prompt) will find this daemon already listening and reuse
  it rather than spawning a second one.
- **Claude Code's own MCP diagnostics** for anything channel-specific (the server never connecting,
  or disconnecting mid-session) — this repo's CLI has no visibility into the host side of that
  connection; see <https://code.claude.com/docs/en/mcp.md>.

## Run record

_Pending first manual execution._ No Claude Code session was available in the environment that
authored this recipe (issue #277); the mechanism underneath each step was individually verified
against the real code and a live daemon while drafting it (see issue #358, discovered — and since
fixed — from that verification work), but the recipe as a whole — run inside an actual Claude Code
session, end to end — has not yet been executed. With #358 fixed, whoever runs it first should
expect every step, including step 8's raw `<channel>` push, to pass as documented **without**
applying step 3's now-optional workaround — that is the clean run that confirms the fix.

| Date | Claude Code version | `agentmonitors` CLI version | Plugin version | Step 1–4 (setup) | Step 5–9 (push) | Step 10 (dedup) | Step 11–12 (ack) | Step 13–16 (blocked channel) | Notes |
| ---- | ------------------- | --------------------------- | -------------- | ---------------- | --------------- | --------------- | ---------------- | ---------------------------- | ----- |
|      |                     |                             |                |                  |                 |                 |                  |                              |       |

Fill one row per run. Record pass/fail per step group (not just overall), the exact
`agentmonitors --version` and Claude Code version, and the plugin version from
`agent-plugins/agentmonitors/.claude-plugin/plugin.json`. Note in "Notes" whether step 3's #358
workaround was applied.
