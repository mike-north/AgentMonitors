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
```

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
Run the notification verification flow below — it simulates exactly what the plugin hooks do.

### Detection latency

After a file change the monitor's observe interval (~30 s default) must elapse before the daemon
detects it, then the urgency settle window (15 s for `high`) must elapse before delivery is
attempted. **Total for a high-urgency monitor: ~45 s.** An empty `hook deliver` response on the
first check is expected — it does not mean the monitor is broken. Wait and re-poll.

### Notification verification flow

```bash
# 1. Choose a session ID for this test run (any unique string)
SESSION_ID="verify-$(date +%s)"
CWD=$(pwd)

# 2. Register the session and boot the daemon (simulates the SessionStart hook)
echo "{\"session_id\":\"$SESSION_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"SessionStart\"}" \
  | agentmonitors session start

# 3. Trigger the monitored condition
#    file-fingerprint: touch a file matched by the monitor's globs
touch path/to/monitored/file.txt

# 4. Wait for detection + settle
#    ~30 s observe interval + ~15 s settle for urgency: high = ~45 s total
sleep 45

# 5. Simulate the UserPromptSubmit hook — claim any pending deliveries
echo "{\"session_id\":\"$SESSION_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"UserPromptSubmit\"}" \
  | agentmonitors hook deliver
```

**Success signal:** the output is a JSON object with a non-empty `additionalContext` field:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### <your-monitor-id> (high)\n..."
  }
}
```

**If the output is empty** (no JSON printed), the settle window may not have elapsed yet or the
daemon hasn't completed its first tick. Wait 15–30 s and re-run step 5 — do not change any files
or re-run step 2 between retries.

Use the cheapest real trigger per source:

- `file-fingerprint`: touch a file matched by the monitor's globs.
- `api-poll`: use `agentmonitors monitor test <path/to/MONITOR.md>` for a connectivity check; for
  change detection, point at a controllable endpoint or modify the response between two ticks.
- `schedule`: choose a near-future cron while testing, or use `agentmonitors monitor test` to verify
  source configuration before restoring the intended cron.
- `incoming-changes`: use a scratch git repo or harmless pathspec; advance the ref with a small commit
  touching a matched path.

## Debug Loop

When the user says "it did not fire", do not guess. Run:

```bash
agentmonitors monitor explain <id> --dir .claude/monitors
```

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
