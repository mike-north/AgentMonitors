---
name: setup-monitors
description: Enable AgentMon monitoring and author verified-firing monitors from plain-language intent. Use when the user asks to "set up agent monitors", "enable monitoring in this repo", "set up a monitor", "watch this file", "watch these files", "tell me when X changes", "notify me when X happens", "watch an API", "watch a schedule", or "turn on agentmonitors here".
---

# Set Up AgentMon Monitoring

Help the user go from intent to a working monitor. Do not make the user edit YAML. Ask concise
questions, write the project-local files yourself, validate them, and verify the monitor fires.

Monitoring needs two project-local pieces:

1. `.claude/agentmonitors.local.md` with `enabled: true` — required so the session-start hook
   registers the daemon. Without it, `agentmonitors session start` quick-exits and no automated
   monitoring runs while you work. (One-shot ticks via `daemon once` work without it.)
2. One or more monitor definitions under `.claude/monitors/`.

## Prerequisites

Run `agentmonitors --help`. If it fails, tell the user to install the CLI:

```bash
npm i -g @agentmonitors/cli
```

## Enable The Project

The fastest path is `agentmonitors init` (no name) — a one-shot bootstrap that performs every step
in this section automatically: it writes `.claude/agentmonitors.local.md` with `enabled: true`,
ensures `.gitignore` ignores `.claude/*.local.*` and `.agentmonitors/`, offers to scaffold a first
monitor, validates the result, and prints a next-steps summary. Use `agentmonitors init
--enable-only` to do just the enable + `.gitignore` steps (no monitor, no prompts), or
`agentmonitors init --yes` to accept defaults non-interactively. It is idempotent, so re-running is
safe. The manual steps below remain valid if you prefer to do them by hand.

Create `.claude/agentmonitors.local.md`:

```markdown
---
enabled: true
---

> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).
```

Ensure `.gitignore` contains:

```gitignore
.claude/*.local.*
.agentmonitors/
```

`.agentmonitors/` is a separate runtime-state directory (per-session hook state) the daemon
creates the moment a session opens — it's regenerated on every run, so it's always safe to delete.

Only add `.claude/monitors/*` to `.gitignore` if the user wants monitors to remain personal. Commit
monitor definitions when they should be shared by the team.

## Author A Monitor

1. Restate the user's intent as a monitor outcome: what changed, and what should the agent do?
2. Scaffold the monitor with `agentmonitors init` rather than writing `MONITOR.md` by hand —
   this produces a valid stub with correct frontmatter and avoids common authoring mistakes:

```bash
agentmonitors init <name> --type <source> --dir .claude/monitors
# Examples:
agentmonitors init watch-ts --type file-fingerprint --dir .claude/monitors
agentmonitors init api-health --type api-poll --dir .claude/monitors
```

3. Choose the smallest shipped `watch.type` that matches the intent:

| Intent | Use `watch.type` | Ask for |
| --- | --- | --- |
| Local files changed, created, deleted, or descoped | `file-fingerprint` | `globs`; optional `cwd` |
| HTTP response/status changed | `api-poll` | `url`; optional `method`, `headers`, `auth`, `change-detection`, `interval` |
| Output of a command/script changed (e.g. `git status`, a CLI health check, a script's JSON) | `command-poll` | `command` (argv array); optional `interval`, `change-detection`, `cwd`, `env`, `timeout` |
| Time-based reminder or recurring check | `schedule` | `cron`; optional `timezone`, `label` |
| Git ref advances touching paths | `incoming-changes` | `paths`; optional `cwd`, `branch`, `interval` |

If no shipped source fits, say it is not monitorable yet.

The minimal `command-poll` shape is:

```yaml
watch:
  type: command-poll
  command:
    - git
    - status
    - --porcelain
```

`command` is an argv array (not a shell string). The default `change-detection.strategy` is `text-diff`; use `json-diff` when the command outputs JSON.

4. **Choose urgency by intent — this controls when the agent is notified:**

   | Intent | Use `urgency` | When delivered |
   | --- | --- | --- |
   | Interrupt the agent mid-turn when the change arrives ("stop me if the build breaks") | `high` | At the next prompt or tool boundary, after a ~15 s settle window |
   | Surface at the next quiet moment; do not interrupt a turn in progress | `normal` (default) | As a reminder only at turn boundaries; full body at session recap |
   | Surface only when idle or at session start | `low` | Session recap only |

   **For "notify me when it changes", use `urgency: high`.** A `normal`-urgency monitor does not
   inject its body text mid-turn — it surfaces as a brief reminder message only, and the full
   monitor text arrives only at session recap (`SessionStart`). If the user wants to be interrupted
   by the change, `urgency: high` is the right default.

   Regardless of urgency, detection latency is **at least 30–45 s** — see Verify It Fires below.

5. Ask only for fields required by the chosen source. Prefer defaults for everything else.
   Add `notify:` only when the user asks for batching/throttling behavior.
6. Edit `.claude/monitors/<id>/MONITOR.md` (or a flat `.claude/monitors/<id>.md`). Use the monitor
   body for the user's judgment and instructions, not facts already captured in `watch:`.

Example body style:

```markdown
When this fires, inspect the change and decide whether implementation or docs need follow-up.
```

## Validate

Run validation after every edit and fix all reported problems:

```bash
agentmonitors validate .claude/monitors
```

## Verify It Fires

Verification proves the agent will be **notified**, not just that an event materialised. The two are
distinct: `monitor explain` can report a materialised event that was never delivered to a session.
Run the reliable manual-test recipe below — it is the only path that works end-to-end without
running inside a Claude Code session.

**The monitor is not done until it has fired and been delivered once.** A monitor that validates
cleanly but has never produced a delivered notification is unverified — treat the flow below as a
required step, not an optional smoke test.

### Why `session start` is not the manual-test path

`agentmonitors session start` is designed for the **plugin's `SessionStart` hook**: it lazy-boots a
daemon with automatic idle reaping (`reap-after-ms` defaults to 5 minutes), so a long multi-step
manual verification will often trigger the reaper before you reach the delivery check. If you then
run `session open` or `hook deliver` manually, those commands may target a different socket than the
daemon that just exited, producing `No lead session is registered` or an empty response. In the live
plugin flow this is fine because hooks keep the daemon alive. For manual testing, use the recipe
below instead.

### Fast-test setup: shorten intervals before verifying

The default poll interval is 30 s for `file-fingerprint` and `command-poll`, 5 min for `api-poll`.
For a test cycle, set a short interval in the `MONITOR.md` frontmatter:

```yaml
watch:
  type: command-poll
  command: [cat, tracked/state.txt]
  interval: 5s       # shorten for testing; restore the real value before committing
notify:
  strategy: debounce
  settle-for: 5s     # shorten the urgency settle window too
urgency: high
```

You can also pass `--poll-ms <ms>` to `daemon run` to override the daemon's tick rate (default
30 000 ms). With `interval: 5s` in the monitor and `--poll-ms 5000` on the daemon, a full
detect-and-settle cycle takes ~10–15 s instead of ~45 s.

### Reliable manual-test recipe

Use an explicit socket path to guarantee all steps talk to the same daemon, regardless of whether
the workspace has an enabled `.claude/agentmonitors.local.md`.

```bash
CWD=$(pwd)
HOST_ID="verify-$(date +%s)"
SOCKET="/tmp/agentmon-verify-$$.sock"

# 1. Start a daemon that never idle-reaps (--reap-after-ms 0).
#    Pass --socket so all steps share the same socket.
#    Use --poll-ms for a faster tick during testing (default: 30000).
agentmonitors daemon run .claude/monitors --socket "$SOCKET" --reap-after-ms 0 --poll-ms 5000 &
DAEMON_PID=$!
sleep 1   # let the socket appear

# 2. Open a lead session on the same socket.
#    Note the AgentMon session ID printed on "Opened session:" line.
agentmonitors session open --socket "$SOCKET" --host-session-id "$HOST_ID" --role lead --workspace "$CWD"
# → Opened session: <AGENTMON_SESSION_ID>
AGENTMON_SESSION_ID=<paste the id from above>

# 3. Trigger the monitored condition (see per-source recipes below).

# 4. Wait for detect + settle.
#    interval + settle-for from MONITOR.md — e.g. 5s + 5s = 10s minimum, add a few seconds margin.
sleep 15

# 5. Confirm the event reached the session:
agentmonitors events list --socket "$SOCKET" --session "$AGENTMON_SESSION_ID" --unread

# 5b. Simulate the UserPromptSubmit hook — claim any pending deliveries and confirm notification:
echo "{\"session_id\":\"$HOST_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"UserPromptSubmit\"}" \
  | agentmonitors hook deliver --socket "$SOCKET"

# 6. Clean up.
kill "$DAEMON_PID"
```

**Success signal:** step 5 prints at least one event row (with monitor ID, urgency, and title),
confirming the event reached the session. Step 5b (`hook deliver`) returning a JSON object with a
non-empty `additionalContext` field confirms the delivery hook would notify the agent:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### <your-monitor-id> (high)\n..."
  }
}
```

**If step 5 prints `No events found.`**, the settle window may not have elapsed yet. Wait and
re-run steps 5–5b — do not change any files or re-open the session between retries.

### Per-source trigger recipes

#### `file-fingerprint`

```bash
# Step 3: touch any file matched by watch.globs
touch path/to/monitored/file.txt
```

#### `command-poll`

```bash
# Step 3: cause the command's output to change.
# Example — the monitor runs `cat tracked/state.txt`:
echo "changed" >> tracked/state.txt

# Example — the monitor runs `git status --porcelain`:
echo "temp" > some-untracked-file.txt
# (the status output now includes the new file)
```

`command-poll` uses a baseline-then-detect pattern: the first tick establishes a baseline; the
second tick detects the change. With `interval: 5s` and the daemon, this means two ticks must
run after the session is opened — the first produces a baseline, the second detects the diff.
Trigger the change **between** the two ticks (i.e. after the session opens but before the second
tick) for fastest detection. If the daemon has already run one tick before you trigger the
change, the change fires on the next tick.

#### `api-poll`

```bash
# Connectivity check (no daemon needed):
agentmonitors monitor test .claude/monitors/<id>/MONITOR.md

# Step 3 for change detection: the response from your endpoint must change between two ticks.
# Options:
#   - Point watch.url at a controllable local server and update its response.
#   - Use a service that returns a timestamp or counter (changes every poll, useful for testing).
#   - Add a query param that forces a cache-bust and changes the response.
```

**For external resources you do not control** (a live third-party URL, a remote API, a remote
repo): `agentmonitors monitor test` confirms the source is correctly configured and can reach the
endpoint, but an actual change-fire requires the remote resource to change between two of the
daemon's ticks. You can confirm authoring is correct; you cannot force a remote change. Set
expectations accordingly — your monitor is verified once the remote resource naturally changes
and the event arrives.

#### `schedule`

```bash
# Step 3: set a cron that fires in the next ~1 minute while testing.
# In MONITOR.md frontmatter, set e.g.:
#   cron: '* * * * *'  # every minute
# Restore the intended cron after verification.
# Or use agentmonitors monitor test to confirm the cron parses correctly.
agentmonitors monitor test .claude/monitors/<id>/MONITOR.md
```

#### `incoming-changes`

```bash
# Step 3: advance the tracked git ref by committing to a path in watch.paths.
# Use a scratch branch or harmless file if you do not want to push real commits.
touch docs/scratch-verify.txt
git add docs/scratch-verify.txt
git commit -m "verify incoming-changes monitor" --no-gpg-sign
# Then trigger a fetch/merge that advances the ref (or simulate with `git pull`).
```

## Debug Loop

When the user says "it did not fire", do not guess. Run:

```bash
agentmonitors monitor explain <id> --dir .claude/monitors
```

**No daemon** needs to be running for this loop: `monitor explain` reads the persisted runtime state
(events and session state) directly from disk. The same applies to `events list` below.

`monitor explain` prints a ✓/✗/○/⏳ status for each pipeline stage, then a final **Verdict** naming
the stage where the signal stopped and the reason. Use the Verdict stage to fix the monitor:

- `definition`: parse/schema/source config problem; edit `MONITOR.md`, then run `validate`.
- `scheduling`: daemon not running or not due; enable the project, start a session, or adjust interval/cron.
- `observation`: source errored, rebaselined, or saw no change; inspect source-specific config and state.
- `notify`: debounce/throttle is holding observations; wait or adjust `notify`.
- `materialization`: source observed but no event was written; inspect runtime error details.
- `delivery`: event exists but no lead session is available, or events are unread/claimed/acknowledged.

**If `monitor explain` shows delivery failure but you believe an event should have been delivered:**
`monitor explain`'s delivery verdict reflects the daemon's session state and can disagree with the
hook-state file when sessions fall out of sync. The **authoritative check** is `events list`:

```bash
# Find the AgentMon session ID (not the host session_id) from session list
agentmonitors session list

# Check unread events for that session
agentmonitors events list --session <agentmon-session-id> --unread
```

Non-empty output from `events list --session … --unread` confirms the event reached the session and
is pending delivery; the `monitor explain` delivery verdict may be stale. If `events list` is also
empty, the event has not reached the session — work backwards through the Verdict stages above.
