---
name: setup-monitors
description: Enable AgentMon monitoring and author verified-firing monitors from plain-language intent. Use when the user asks to "set up agent monitors", "enable monitoring in this repo", "set up a monitor", "watch this file", "watch these files", "tell me when X changes", "notify me when X happens", "watch an API", "watch a schedule", or "turn on agentmonitors here".
---

# Set Up AgentMon Monitoring

Help the user go from intent to a working monitor. Do not make the user edit YAML. Ask concise
questions, write the project-local files yourself, validate them, and verify the monitor fires.

Monitoring needs two project-local pieces:

1. `.claude/agentmonitors.local.md` with `enabled: true` so hooks boot/register the daemon.
2. One or more monitor definitions under `.claude/monitors/`.

Without the activation file, `agentmonitors session start` quick-exits and no monitor ticks.

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
2. Choose the smallest shipped `watch.type` that matches the intent:

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

3. Ask only for fields required by the chosen source. Prefer defaults for everything else:
   - `urgency: normal` unless the user needs idle-only (`low`) or interrupting (`high`) delivery.
   - Add `notify:` only when the user asks for batching/throttling behavior.
4. Write `.claude/monitors/<id>/MONITOR.md` (or a flat `.claude/monitors/<id>.md`). Use the monitor
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

Verification is mandatory. The monitor is not done until it has fired once or until you clearly tell
the user what external condition is still needed to make it fire.

Use the cheapest real verification:

- `file-fingerprint`: create or modify a scratch file matched by the monitor, run the monitor through
  a baseline tick, then a changed tick.
- `api-poll`: use `agentmonitors monitor test <path/to/MONITOR.md>` if the endpoint can be polled
  safely; for status/body-change verification, point at a controllable scratch endpoint when possible.
- `schedule`: choose a near-future cron while testing, or use `agentmonitors monitor test` to verify
  source configuration before restoring the intended cron.
- `incoming-changes`: use a scratch git repo or harmless pathspec; advance the ref with a small commit
  touching a matched path.

Useful commands:

```bash
agentmonitors monitor test .claude/monitors/<id>/MONITOR.md
agentmonitors monitor history <id>
agentmonitors monitor explain <id> --dir .claude/monitors
```

If a daemon-backed check is needed, use the project daemon started by the hooks or start a temporary
daemon, then stop it when done. Confirm the final report with `monitor history` or `monitor explain`.

## Debug Loop

When the user says "it did not fire", do not guess. Run:

```bash
agentmonitors monitor explain <id> --dir .claude/monitors
```

`monitor explain` prints a ✓/✗/○/⏳ status for each pipeline stage, then a final **Verdict** naming the stage where the signal stopped and the reason. Use the Verdict stage to fix the monitor:

- `definition`: parse/schema/source config problem; edit `MONITOR.md`, then run `validate`.
- `scheduling`: daemon not running or not due; enable the project, start a session, or adjust interval/cron.
- `observation`: source errored, rebaselined, or saw no change; inspect source-specific config and state.
- `notify`: debounce/throttle is holding observations; wait or adjust `notify`.
- `materialization`: source observed but no event was written; inspect runtime error details.
- `delivery`: event exists but no lead session is available, or events are unread/claimed/acknowledged.
