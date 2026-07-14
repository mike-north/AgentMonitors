---
name: agentmonitors-setup
description: Set up Agent Monitors — a local-first, durable monitoring system for coding agents — end to end. Detect the host, install the CLI, author a monitor from the user's plain-language intent, and prove it actually delivers before declaring success. Use this when a user points you at this URL, or asks to "set up agent monitors", "enable monitoring here", "watch this file/API/command", "notify me when X changes", or "turn on agentmonitors".
---

# Agent Monitors — agent setup guide

You were handed this file directly (probably as `https://agentmonitors.io/skill.md`), with no
other context. That's enough. This document is self-contained: follow it top to bottom and you
can take a user from nothing installed to a monitor that has verifiably fired.

## What you're setting up

Agent Monitors watches something the user cares about — a file, an HTTP endpoint, a command's
output, a git ref, a schedule — with a small local daemon, and tells you (the agent) when it
changes, at a good moment in your session. It is **local-first**: everything runs on the user's
machine, nothing is sent to a cloud service. Delivery to you happens **entirely through your
host's hook mechanism** — there is no separate service to sign up for.

## How to behave

- **Do the work yourself.** Install the CLI, write the config files, run validation, and run the
  verification recipe below. Don't hand the user a list of commands to run themselves.
- **Ask only for intent**, not configuration. "What do you want to watch, and what should I do
  when it changes?" is normally the only question you need. Infer the rest (source type, globs,
  urgency) from the answer using the tables below.
- **Never make the user hand-edit YAML.** Scaffold with `agentmonitors init`, then edit the
  generated file yourself.
- **Do not declare the monitor "set up" until you have demonstrated a delivered event.** A
  monitor that only parses and validates is unverified. Phase 5 below is not optional — it is
  the difference between "I wrote a config file" and "I proved your agent gets told."

---

## Phase 0 — Prerequisites: install the CLI

Check whether the CLI is already on the user's `PATH`:

```bash
agentmonitors --help
```

If that fails, install it:

```bash
npm install -g agentmonitors
```

This installs the `agentmonitors` binary (a thin launcher over the published `@agentmonitors/cli`
package — both resolve to the same CLI; `agentmonitors` is just the short name). Verify with
`agentmonitors --help` again, or `npx agentmonitors --help` to try it without a global install.

---

## Phase 1 — Detect the host, then branch

Figure out which of these three situations you're in before doing anything else.

### 1a. Claude Code, plugin install available (the common case)

If you can run Claude Code slash commands, add the plugin marketplace and install the plugin:

```text
/plugin marketplace add mike-north/AgentMonitors
/plugin install agentmonitors@agentmonitors
```

This wires Claude Code's `SessionStart` / `UserPromptSubmit` / `SessionEnd` lifecycle hooks to the
CLI automatically. Once a project is enabled (Phase 2), monitors just show up in sessions — you
never run delivery commands by hand in normal use. Continue to Phase 2.

### 1b. Claude Code, hooks-only (MCP blocked / restricted-corporate)

The plugin also ships an optional MCP "channel" for push-style delivery. If your organization
blocks MCP servers or third-party plugin marketplaces by policy, that's fine —
**delivery semantics are identical without it.** The channel is a second, additive transport for
the same durable events; the hook-based transport below is the default for every environment and
never depends on channels.

If you can install the plugin (1a) but MCP is blocked, do that — the hooks still work; you only
lose the optional real-time push, not delivery itself.

If you cannot install any plugin at all, wire the hooks by hand in `.claude/settings.json` (or
`.claude/settings.local.json` for a personal-only, gitignored setup) at the project root:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v agentmonitors >/dev/null 2>&1 && agentmonitors session start || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v agentmonitors >/dev/null 2>&1 && agentmonitors hook deliver || true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v agentmonitors >/dev/null 2>&1 && agentmonitors session end || true"
          }
        ]
      }
    ]
  }
}
```

Each command is guarded (`command -v … && … || true`) so the host hook never reports a failure
when the CLI is missing from `PATH` or exits non-zero — an unguarded failing hook would disrupt
the user's session. This mirrors the guard the official plugin's own hook wiring uses.

- `SessionStart` runs `agentmonitors session start`, which lazy-boots the per-project daemon and
  registers the session (and prints a recap of anything already pending).
- `UserPromptSubmit` runs `agentmonitors hook deliver`, which claims and injects pending monitor
  context at each turn boundary.
- `SessionEnd` runs `agentmonitors session end`, which deregisters the session so the idle daemon
  can reap itself.

All three read the hook's JSON payload from **stdin** (Claude Code's standard hook input contract)
— no extra flags needed. Continue to Phase 2.

### 1c. Codex or another host

**Honest current state:** Agent Monitors' automatic in-session delivery is Claude-Code-specific
today — there is no Codex (or other host) hook wiring shipped yet. What *does* work today,
host-independently, is everything upstream of delivery: install the CLI, author and validate
monitors, and run the daemon to observe changes and materialize durable events. You can still
prove the underlying mechanism fires correctly using the CLI-only verification recipe in Phase 5
(it doesn't depend on any host-specific hook — it drives the same daemon/session/events surface
directly). Say this plainly to the user rather than implying full parity with the Claude Code
path: monitor authoring and CLI-level verification work today; automatic delivery into a live
Codex/other session does not yet.

---

## Phase 2 — Enable the project

Monitoring is off by default per project. Create the gitignored opt-in file:

```bash
mkdir -p .claude
cat > .claude/agentmonitors.local.md <<'EOF'
---
enabled: true
---

> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).
EOF
```

Make sure `.gitignore` contains:

```gitignore
.claude/*.local.*
/.agentmonitors/
```

This file is per-developer, not committed. Without it, `agentmonitors session start` quick-exits
and no automated monitoring runs during a session (a one-shot `agentmonitors daemon once` still
works without it — the opt-in only gates the session-lifecycle hooks).

`.agentmonitors/` is a separate runtime-state directory (per-session hook state) the daemon
creates the moment a session opens — it's regenerated on every run, so it's always safe to
delete. `agentmonitors init` (bare or `--enable-only`) ignores both lines for you automatically.

Only add `.claude/monitors/*` to `.gitignore` if the user wants monitors to stay personal;
otherwise commit monitor definitions so the team shares them.

---

## Phase 3 — Author a monitor from the user's intent

1. Restate the user's intent as an outcome: *what* changed, and *what should you do about it*?
2. Scaffold with `agentmonitors init` — don't hand-write `MONITOR.md` frontmatter, it's easy to
   get subtly wrong:

   ```bash
   agentmonitors init <name> --type <source> --dir .claude/monitors
   # Examples:
   agentmonitors init watch-ts --type file-fingerprint --dir .claude/monitors
   agentmonitors init api-health --type api-poll --dir .claude/monitors
   ```

   (The flag is `--type`, not `--source`.)

3. Pick the smallest source that matches the intent:

   | Intent | `--type` | Ask for |
   | --- | --- | --- |
   | Local files changed, created, deleted | `file-fingerprint` | `globs`; optional `cwd` |
   | HTTP response/status changed | `api-poll` | `url`; optional `method`, `headers`, `auth`, `change-detection`, `interval` |
   | Output of a command/script changed (e.g. `git status`, a health-check script) | `command-poll` | `command` (argv array, not a shell string); optional `interval`, `change-detection`, `cwd`, `env`, `timeout` |
   | Time-based reminder or recurring check | `schedule` | `cron`; optional `timezone`, `label` |
   | Local git ref advances touching given paths | `incoming-changes` | `paths`; optional `cwd`, `branch`, `interval` |

   If none of these fit, say so — it isn't monitorable yet.

   Minimal `command-poll` shape:

   ```yaml
   watch:
     type: command-poll
     command:
       - git
       - status
       - --porcelain
   ```

   `command` is an argv array. Default `change-detection.strategy` is `text-diff`; use
   `json-diff` when the command's output is JSON.

4. **Choose urgency by intent — this controls when you're notified:**

   | Intent | `urgency` | When delivered |
   | --- | --- | --- |
   | Interrupt mid-turn the moment it happens ("stop me if the build breaks") | `high` | At the next prompt/tool boundary, after the change has settled for ~15s |
   | Surface at the next natural pause; don't interrupt an in-progress turn | `normal` (default) | A brief reminder at turn boundaries; full detail at session recap |
   | Only worth mentioning when idle or at session start | `low` | Session recap only |

   **For "notify me when it changes," use `urgency: high`.** A `normal`-urgency monitor produces
   only a short reminder mid-turn, not the full body — the details arrive at the next
   `SessionStart` recap instead. If the user wants to be interrupted, `high` is correct.

   Detection latency is **at least 30–45s** in the default configuration — see the fast-test
   setup in Phase 5 for shortening this while you verify.

5. Ask only for the fields the chosen source requires; default everything else. Add `notify:`
   only if the user wants specific batching/throttling behavior.
6. Edit `.claude/monitors/<id>/MONITOR.md` (or a flat `.claude/monitors/<id>.md`). The body is
   your handling instruction — what to do when it fires — not facts already in `watch:`.

   ```markdown
   When this fires, inspect the change and decide whether implementation or docs need follow-up.
   ```

---

## Phase 4 — Validate

Run this after every edit and fix everything it reports:

```bash
agentmonitors validate .claude/monitors
```

---

## Phase 5 — Verify it actually fires (mandatory)

Validation proves the file parses. It does **not** prove you'll be notified. Those are different
claims — `monitor explain` can show a materialized event that was never delivered to a session.
**The monitor is not done until you've proven a delivered event, end to end.** Use the recipe
below; it works even outside a live Claude Code session, and it's host-agnostic (Phase 1c hosts
can use it too, minus the automatic hook wiring).

### Why not just use `agentmonitors session start`?

`session start` is designed for the real `SessionStart` hook: it lazy-boots a daemon with
automatic idle reaping (5 minutes by default), which is fine in a live session where hooks keep
the daemon alive, but can reap mid-way through a slower manual verification. Use the explicit
recipe below instead, which pins everything to one daemon on one socket that never reaps.

### Speed it up for the test

Default poll interval is 30s (`file-fingerprint`, `command-poll`) or 5min (`api-poll`). For a
verification pass only, shorten it in the `MONITOR.md` frontmatter, and restore the real value
afterward:

```yaml
watch:
  type: command-poll
  command: [cat, tracked/state.txt]
  interval: 5s # shorten for testing only
notify:
  strategy: debounce
  settle-for: 5s # shorten for testing only
urgency: high
```

You can also pass `--poll-ms <ms>` to `daemon run` (default 30000) to shorten the daemon's own
tick rate.

### The recipe

Use an explicit socket so every step talks to the same daemon, independent of whether the project
has an enabled `.claude/agentmonitors.local.md`:

```bash
CWD=$(pwd)
HOST_ID="verify-$(date +%s)"
SOCKET="/tmp/agentmon-verify-$$.sock"

# 1. Start a daemon that never idle-reaps, on an explicit socket every later
#    step will also target.
agentmonitors daemon run .claude/monitors --socket "$SOCKET" --reap-after-ms 0 --poll-ms 5000 &
DAEMON_PID=$!
sleep 1

# 2. Open a lead session on the same socket, capturing the AgentMon session
#    id from the JSON output (it is NOT the same as $HOST_ID).
AGENTMON_SESSION_ID=$(agentmonitors session open --socket "$SOCKET" --host-session-id "$HOST_ID" --role lead --workspace "$CWD" --format json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo "AgentMon session: $AGENTMON_SESSION_ID"

# 3. Trigger the monitored condition (per-source recipes below).

# 4. Poll `events list` until the materialized event shows up. --unread always
#    talks to the live daemon over the socket (it errors if the daemon isn't
#    reachable — start it first, as above).
for i in $(seq 1 20); do
  OUT=$(agentmonitors events list --socket "$SOCKET" --session "$AGENTMON_SESSION_ID" --unread --format json)
  [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$OUT")" -ge 1 ] && break
  sleep 2
done
echo "$OUT"

# 5. Simulate the UserPromptSubmit hook: claim any pending deliveries and
#    confirm the agent would actually be notified.
echo "{\"session_id\":\"$HOST_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"UserPromptSubmit\"}" \
  | agentmonitors hook deliver --socket "$SOCKET"

# 6. Clean up.
kill "$DAEMON_PID"
```

**Success signal:** step 4 prints at least one event row (monitor id, urgency, title). Step 5
(`hook deliver`) returning a non-empty JSON object with a populated
`hookSpecificOutput.additionalContext` confirms the delivery hook would actually notify the agent:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### <your-monitor-id> (high)\n..."
  }
}
```

**If step 5 prints nothing for a `high`-urgency monitor, that can be expected, not a bug — keep
polling.** `events list` (step 4) surfaces an event as soon as it materializes. `hook deliver`
at the `turn-interruptible` lifecycle applies a *separate*, fixed ~15s "claim settle" window
measured from the event's own creation time before it will surface the event's body — independent
of your monitor's `notify.settle-for`. So for `high` urgency, budget roughly
`interval + settle-for + 15s` before step 5 returns content, and re-run it every few seconds
until it does. **Do not** change any files or re-open the session while you wait — that resets the
condition you're trying to observe. A `normal`- or `low`-urgency monitor doesn't have this extra
wait: `hook deliver` surfaces a reminder (not the full body) as soon as the event is unread.

### Per-source trigger recipes (step 3)

**`file-fingerprint`** — touch any file matched by `watch.globs`:

```bash
touch path/to/monitored/file.txt
```

**`command-poll`** — change the command's output between two ticks. Example, watching
`cat tracked/state.txt`:

```bash
echo "changed" >> tracked/state.txt
```

`command-poll` baselines on the first tick and detects on the second, so trigger the change
between session-open and the second tick for the fastest detection.

**`api-poll`** — the response from `watch.url` must change between two ticks. Point it at a
controllable local server, or a source that changes every poll. Without a controllable endpoint,
`agentmonitors monitor test .claude/monitors/<id>/MONITOR.md` confirms the source is configured
and reachable, but an actual fire needs the remote resource to change on its own.

**`schedule`** — set a cron that fires within the next minute while testing (e.g. `'* * * * *'`),
then restore the real cron afterward. `agentmonitors monitor test <path>` confirms the cron
parses.

**`incoming-changes`** — advance the tracked ref by committing to a watched path, then trigger a
fetch/merge that advances it (or simulate with `git pull`):

```bash
touch docs/scratch-verify.txt
git add docs/scratch-verify.txt
git commit -m "verify incoming-changes monitor" --no-gpg-sign
```

---

## Phase 6 — Debug loop

When the user says "it didn't fire," don't guess — run:

```bash
agentmonitors monitor explain <id> --dir .claude/monitors
```

This reads persisted runtime state (recent observations, materialized events, session state)
**directly from disk — no live daemon required.** It prints a status per pipeline stage, then a
**Verdict** naming where the signal stopped:

- `definition` — parse/schema/source config problem; edit `MONITOR.md`, then re-run `validate`.
- `scheduling` — the daemon isn't running or the monitor isn't due yet; enable the project, start
  a session, or check the interval/cron.
- `observation` — the source ran but errored, rebaselined, or saw no change; inspect the
  source-specific config and state.
- `notify` — a debounce/throttle hold is in effect; wait, or adjust `notify:`.
- `materialization` — the source observed a change but no event was written; inspect the
  runtime error details in the output.
- `delivery` — an event exists but no lead session is available, or it's already
  unread/claimed/acknowledged.

If `monitor explain`'s delivery verdict disagrees with what you expect, the authoritative check is
`events list` — but note that **`events list` needs a reachable daemon** (unlike `monitor
explain`, it has no offline fallback and errors if none is running):

```bash
agentmonitors session list                                            # find the AgentMon session id
agentmonitors events list --session <agentmon-session-id> --unread    # requires a live daemon
```

Non-empty output confirms the event reached the session and is pending delivery — the `monitor
explain` delivery verdict may simply be stale. If `events list` is also empty (once the daemon is
confirmed running), the event never reached the session; work backward through the Verdict stages
above.
