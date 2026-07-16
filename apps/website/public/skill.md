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

Monitoring is off by default per project. Check whether your CLI has the one-shot bootstrap flag
first — it's the newer, preferred path, but some installs predate it:

```bash
agentmonitors init --help
```

**If `--enable-only` is listed**, use it. It creates the gitignored opt-in file and updates
`.gitignore` for you, with no monitor and no prompts:

```bash
agentmonitors init --enable-only
```

This creates `.claude/agentmonitors.local.md` (the per-developer opt-in file) and adds both
`.claude/*.local.*` and `/.agentmonitors/` to `.gitignore` — no manual file-editing needed. Skip
straight to Phase 3.

**If `--enable-only` is not listed** (older CLI version), create an equivalent enable file by hand:

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

Either way: this file is per-developer, not committed. Without it, `agentmonitors session start`
quick-exits and no automated monitoring runs during a session (a one-shot `agentmonitors daemon
once` still works without it — the opt-in only gates the session-lifecycle hooks).

`.agentmonitors/` is a separate runtime-state directory (per-session hook state) the daemon
creates the moment a session opens — it's regenerated on every run, so it's always safe to
delete.

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
**The monitor is not done until you've proven a delivered event, end to end.**

### Run `agentmonitors verify`

```bash
agentmonitors verify <monitor-id>
```

This is the whole proof in one command, and it's host-agnostic (Phase 1c hosts can use it too,
minus the automatic hook wiring): it boots an isolated daemon on a throwaway socket and database,
registers a throwaway session, triggers a real change, waits for the event to materialize, and
claims it through the same delivery path a live hook uses — then tears everything down. Check the
exit code: `0` means PASS, non-zero means FAIL with the failing stage named directly. Prefer
`--format json` if you want to branch on the result programmatically instead of parsing text (spec
005 §16 documents the stable JSON shape: `ok`, `monitorId`, `stages`, `failure`, `additionalContext`,
`daemonStderr`, `elapsedMs`).

**Auto-trigger only covers `file-fingerprint`.** For a literal single-file glob (e.g.
`docs/notes.md`), it edits the watched file itself and restores it on exit. For a pattern glob, it
writes a scratch sibling that reuses the glob's static directory prefix and extension — but that
placement can't fabricate a match for a glob whose filename segment is itself a wildcard (e.g.
`file-?.md`) or whose only variability is a wildcard directory with a literal filename (e.g.
`data-*/report.md`); those have no derivable sibling. For every other source — `api-poll`,
`command-poll`, `schedule`, `incoming-changes` — and those un-fabricatable file-fingerprint globs,
have `verify` run the change itself with `--trigger-cmd`:

```bash
agentmonitors verify <monitor-id> --trigger-cmd '<shell command that causes the change>'
```

`--trigger-cmd` is the **decoupled trigger**: after baseline, `verify` runs your shell command
(from the workspace directory) to cause the watched change, then observes and delivers — one
self-contained, non-interactive command. **This is the mode to use as an agent**, because
`--manual` (below) blocks and does not read stdin, so a call-and-return harness (one shell command
per tool call) cannot make the change while it waits. For a `command-poll` watching
`git status --porcelain`, that's e.g. `--trigger-cmd 'touch new-file.txt'`; **you still have to know
what change actually registers for that source** — see "Per-source trigger recipes" in the appendix
(e.g. `file-fingerprint` needs a content change, not just a `touch`; `command-poll` diffs command
output between ticks; `schedule` needs a cron that fires soon). The command's effects are not
reverted, and a non-zero exit is a `setup` failure (fix the command, not the monitor).

`--manual` is the alternative when you'd rather make the change out-of-band yourself:

```bash
agentmonitors verify <monitor-id> --manual
```

It **blocks** for the detect budget and watches for a change you make in a _separate_ step — it is
_not_ an interactive stdin prompt. With a persistent shell you can background the run
(`verify … --manual --timeout-ms <generous> &`), make the change, then read the result; a
call-and-return harness can't, and should use `--trigger-cmd` instead. `--manual` and
`--trigger-cmd` are mutually exclusive.

**If the user wants a stakeholder-presentable proof**, or you want the real workspace daemon left
running afterward so a follow-up `agentmonitors doctor` also goes green, add
`--use-workspace-daemon`. This requires the project to already be enabled (Phase 2) — it runs
`verify` against the real workspace daemon/database instead of a throwaway one and leaves it
running rather than tearing it down.

**Success looks like** a `PASS` line, with a `deliver` stage reporting
`claimed at turn-interruptible` (for `urgency: high`) or `claimed at post-compact`
(`normal`/`low`), followed by the delivered `additionalContext` — that's exactly what a live hook
would inject into the
agent's next turn:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### <your-monitor-id> (high)\n..."
  }
}
```

(That's the shape a live `UserPromptSubmit` hook receives; `verify`'s own PASS output prints the
raw `additionalContext` text, not this wrapper.)

If `verify` fails, the `FAIL` line names the stage and reason directly — don't guess from empty
output the way the fully-manual recipe below forces you to:

- `no-change` / `no-files-matched` means the trigger didn't do anything the source could detect
  (e.g. a `touch` on a file whose content didn't change) — fix the trigger, don't retry hoping it
  resolves itself.
- `budget-exceeded` means the change was never detected within the derived wait budget —
  `--timeout-ms` to extend it, or run `agentmonitors monitor explain <id>` to see where the
  pipeline actually stalled.
- `daemon-died` prints the daemon's own captured stderr — that's the real crash reason, not an
  ambiguous timeout.

For debugging an individual pipeline stage by hand, or a host without `agentmonitors verify`
available, see "Appendix: Advanced — manual, host-agnostic verification" at the end of this
document.

---

## Phase 6 — Debug loop

If `agentmonitors verify` failed, its `FAIL` line and `--format json` output already name the
stage and reason — that's usually enough. Its daemon and database are temporary and deleted on
exit (unless you passed `--use-workspace-daemon`, in which case they're the real workspace ones
and `monitor explain`/`doctor` already see them with no extra flags), so there's no state to
inspect after a plain `verify` run beyond what it already printed. If you ran the appendix's fully
manual recipe instead (which pins `AGENTMONITORS_DB` by hand), see that appendix's own debug notes
for reading back its persisted state.

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

**`--unread` means unacknowledged, not "never seen."** It matches every event this session hasn't
run `events ack` on yet — including one already surfaced once at a delivery lifecycle. Each row's
`deliveryState` field (`unread`, `claimed`, or `acknowledged`) tells you which: `claimed` means the
event already reached a hook delivery and is waiting on `events ack`, not stuck undelivered.

---

## Appendix: Advanced — manual, host-agnostic verification

`agentmonitors verify` above covers the common case. This appendix drives the exact same
daemon → session → event → delivery pipeline **by hand, one step at a time** — useful for
debugging an individual pipeline stage, or a host without `agentmonitors verify` available. It
works even outside a live Claude Code session.

### Why not just use `agentmonitors session start`?

`session start` is designed for the real `SessionStart` hook: it lazy-boots a daemon with
automatic idle reaping (5 minutes by default), which is fine in a live session where hooks keep
the daemon alive, but can reap mid-way through a slower manual verification. Use the explicit
recipe below instead, which pins everything to one daemon on one socket that never reaps.

### Speed it up for the test

`agentmonitors verify` derives its own poll budget automatically — this shortening step is only
useful for the manual recipe below, which needs its poll loops sized by hand. Default poll
interval is 30s (`file-fingerprint`, `command-poll`) or 5min (`api-poll`). For a
verification pass only, shorten it in the `MONITOR.md` frontmatter, and restore the real value
afterward. `file-fingerprint` takes the same `watch.interval` knob as `command-poll` — it isn't
command-poll-only:

```yaml
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
  interval: 5s # shorten for testing only
notify:
  strategy: debounce
  settle-for: 5s # shorten for testing only
urgency: high
```

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
tick rate — but that only controls the daemon's tick granularity, not any individual monitor's due
time; `watch.interval` above (or the `api-poll`/`schedule` equivalents) is what actually governs
when a specific monitor comes due. Budget step 4's poll loop below (event materialization) the same
way step 5 budgets `hook deliver`: roughly `interval + settle-for`, before assuming nothing
happened.

### The recipe

Use an explicit socket so every step talks to the same daemon, independent of whether the project
has an enabled `.claude/agentmonitors.local.md`:

```bash
CWD=$(pwd)
HOST_ID="verify-$(date +%s)"
SOCKET="/tmp/agentmon-verify-$$.sock"
# Isolate this recipe's own runtime state from any other daemon on the
# machine (and from a previous run of this same recipe in the same
# directory). Without this, a rerun can reuse a prior baseline and skew the
# tick-count assumptions in the per-source recipes below (issue #338).
export AGENTMONITORS_DB="/tmp/agentmon-verify-$$.db"

# 1. Start a daemon that never idle-reaps, on an explicit socket every later
#    step will also target.
agentmonitors daemon run .claude/monitors --socket "$SOCKET" --reap-after-ms 0 --poll-ms 5000 &
DAEMON_PID=$!
sleep 1

# 2. Open a lead session on the same socket, capturing the AgentMon session
#    id (it is NOT the same as $HOST_ID) via --format id — prints just the
#    bare id, no JSON parsing needed.
AGENTMON_SESSION_ID=$(agentmonitors session open --socket "$SOCKET" --host-session-id "$HOST_ID" --role lead --workspace "$CWD" --format id)
echo "AgentMon session: $AGENTMON_SESSION_ID"

# 2b. Wait a full poll interval (matching --poll-ms above) before triggering
#     anything. A monitor with no prior observation is always "due," so the
#     daemon's first tick for it runs immediately at startup — before waiting
#     --poll-ms, and independent of step 2's session-open, which only
#     registers a delivery recipient and does not affect tick timing — and
#     every bundled source except `schedule` treats that first tick as a
#     silent baseline for *change* observations (see "Per-source trigger
#     recipes" below; `command-poll` is a partial exception — a first-ever
#     command that fails still surfaces a health observation on that tick).
#     This wait guarantees the baseline tick has already completed before
#     step 3.
sleep 5

# 3. Trigger the monitored condition (per-source recipes below).

# 4. Poll `events list` until the materialized event shows up. --unread always
#    talks to the live daemon over the socket (it errors if the daemon isn't
#    reachable — start it first, as above). This loop's 20 x 2s = 40s budget
#    assumes the shortened `interval` + `settle-for` from "Speed it up for the
#    test" above (5s + 5s here); at default/unshortened values (e.g.
#    file-fingerprint's 30s default interval with no override), widen the
#    retry count to cover `interval + settle-for` — the same formula step 5
#    budgets for `hook deliver`, one stage later.
for i in $(seq 1 20); do
  OUT=$(agentmonitors events list --socket "$SOCKET" --session "$AGENTMON_SESSION_ID" --unread --format json)
  [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$OUT")" -ge 1 ] && break
  sleep 2
done
echo "$OUT"

# 5. Simulate the UserPromptSubmit hook: claim any pending deliveries and
#    confirm the agent would actually be notified. Empty stdout usually means
#    nothing was claimable yet — poll the same way step 4 does. But empty
#    stdout is also how several misconfigurations look (workspace not
#    enabled, daemon unreachable, ...), so if the loop never returns content,
#    run `agentmonitors hook deliver --debug` (writes a step-by-step
#    diagnosis to stderr) to tell the two apart.
for i in $(seq 1 20); do
  OUT5=$(echo "{\"session_id\":\"$HOST_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"UserPromptSubmit\"}" \
    | agentmonitors hook deliver --socket "$SOCKET")
  [ -n "$OUT5" ] && break
  echo "(hook deliver: nothing claimable yet, retrying...)" >&2
  sleep 2
done
echo "$OUT5"

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

**If step 4 or step 5's loop keeps retrying, don't assume it's just a settle window — check what
the daemon actually recorded first:**

```bash
agentmonitors monitor history <id> --socket "$SOCKET"
```

A row whose result column shows `no-change` means the trigger in step 3 didn't actually alter
anything the source could detect (e.g. a `touch` on a file whose content didn't change under
`file-fingerprint`'s content-hash comparison) — fix the trigger, don't keep waiting.

A row showing `suppressed` means the opposite: the source detected a real change (the trigger
worked), but a debounce/throttle hold in `notify:` is delaying it from becoming an event this tick
— expected mid-settle, not a broken trigger. Wait for the next tick, or check `monitor explain`'s
notify stage.

Only once the result column shows `triggered` — or step 4 has already printed an event row — is a
still-empty step 5 loop for a `high`-urgency monitor expected, not a bug. `events list` (step 4)
surfaces an event as soon as it materializes. `hook deliver` at the `turn-interruptible` lifecycle
applies a *separate*, fixed ~15s "claim settle" window measured from the event's own creation time
before it will surface the event's body — independent of your monitor's `notify.settle-for`. So for
`high` urgency, budget roughly `interval + settle-for + 15s` before step 5's loop returns content —
the 20 × 2s retry window above comfortably covers that. **Do not** change any files or re-open the
session while you wait for step 5 once the event already exists — that resets the condition you're
trying to observe. A `normal`-urgency monitor doesn't have this extra wait: `hook deliver` surfaces
a reminder (not the full body) as soon as the event is unread (002 §9.2). `low` urgency is delivered
only at the `turn-idle` lifecycle (002 §9.3, §13.2) — this recipe's step 5 sends
`UserPromptSubmit`, which maps to `turn-interruptible` only, so it never exercises low-urgency
delivery; expect step 5 to keep returning empty for a `low`-urgency monitor regardless of how long
you wait.

**This recipe's daemon is invisible to `doctor`.** Everything above runs against the explicit
`$SOCKET` / `$AGENTMONITORS_DB`. `agentmonitors doctor` and `monitor explain` auto-discover the
*workspace's own* socket — falling back to the shared global default only when the workspace isn't
enabled — so neither ever resolves this recipe's throwaway `$SOCKET` (both still honor
`AGENTMONITORS_DB` if it's set in their environment). Running plain `agentmonitors doctor` right
after a successful run of this recipe is expected to still report the monitor "never observed" or
the daemon unreachable — that's a different daemon than the one `doctor` resolved, not a
regression. To check the setup a real agent session would actually use, start a daemon on the
workspace's own socket (`agentmonitors daemon run` — no `--socket`) or open a live session, then
re-run `doctor`.

**For a stakeholder-presentable proof** (e.g. showing a security reviewer that monitoring is
actually wired up), don't screenshot the isolated-socket recipe's output — it's throwaway and
proves the mechanism, not the live setup. Instead, start the workspace's own daemon
(`agentmonitors daemon run`, no `--socket`) and screenshot `doctor`'s all-green summary alongside
the `hook deliver` JSON from step 5 above.

### Per-source trigger recipes (step 3)

A monitor with no prior observation is always "due," so the daemon's very first tick for it runs
immediately at startup — before waiting `--poll-ms` at all. `file-fingerprint`, `api-poll`,
`command-poll`, and `incoming-changes` all treat that first tick as a **silent baseline**: whatever
state exists at that moment becomes the reference point, and no *change* observation is ever
emitted for it. A change that lands *before* this first tick finishes is folded straight into the
baseline and is never detected — not on that tick, not on any later one, because later ticks diff
against the state the *previous* tick captured, not against "what changed since the daemon
started." The one exception is `command-poll`'s health tracking: if the command's first-ever
execution *fails*, that failure isn't folded into a silent baseline — it still surfaces a
`Command failing: …` health observation on tick 1, because there is no prior "ok" state for the
failure to be silently reconciled against. `schedule` has no baseline: it emits an observation on
any tick where its cron matches, from the first eligible tick onward. Step 2b's wait exists
precisely to dodge this race — by the time you reach step 3, the baselining first tick has already
completed, so whatever you trigger next is guaranteed to be detected on a subsequent tick.

**`file-fingerprint`** — change the *content* of a file matched by `watch.globs`. This source
detects changes by content hash, not mtime or existence, so a bare `touch` on an existing file
leaves the hash unchanged and is silently ignored — append real content instead:

```bash
echo "// verify $(date)" >> path/to/monitored/file.txt
```

**`command-poll`** — change the command's output between two ticks. Example, watching
`cat tracked/state.txt`:

```bash
echo "changed" >> tracked/state.txt
```

Each tick after the baseline diffs against the *previous* tick's captured output (a rolling
comparison), so once the baseline tick has run, whichever tick executes after you make the change
will detect it. This assumes a fresh baseline, which is why the recipe isolates
`$AGENTMONITORS_DB` above — reusing a database from a prior run of this same recipe means the
daemon's first tick already has a baseline from that earlier run.

**Gotcha, `git status --porcelain` monitors specifically:** this is `command-poll`'s analog of the
`file-fingerprint` `touch` no-op above. `git status --porcelain` reports an already-untracked file
as `?? path` regardless of its content — appending to it again doesn't change that line, so
re-touching an existing untracked file is a silent no-op trigger here too. The trigger must add,
remove, or modify a *tracked* file, or introduce a genuinely *new* untracked path — not write again
to a file that's already untracked.

**`api-poll`** — the response from `watch.url` must change between two ticks. Point it at a
controllable local server, or a source that changes every poll. Without a controllable endpoint,
`agentmonitors monitor test .claude/monitors/<id>/MONITOR.md` confirms the source is configured
and reachable, but an actual fire needs the remote resource to change on its own.

**`schedule`** — set a cron that fires within the next minute while testing (e.g. `'* * * * *'`),
then restore the real cron afterward. `agentmonitors monitor test <path>` confirms the cron
parses. No baseline race here — just make sure the cron is set *before* starting the daemon, so
its first eligible tick can catch the matching minute.

**`incoming-changes`** — advance the tracked ref by committing to a watched path, then trigger a
fetch/merge that advances it (or simulate with `git pull`):

```bash
touch docs/scratch-verify.txt
git add docs/scratch-verify.txt
git commit -m "verify incoming-changes monitor" --no-gpg-sign
```

---

### Reading back the manual recipe's state

This recipe's daemon is dead once its step 6 (`kill "$DAEMON_PID"`) runs, and its socket is
invisible to `doctor`/`monitor explain` even while it's alive — those auto-discover the
*workspace's own* socket (falling back to the shared global default only when the workspace isn't
enabled), never this recipe's throwaway `$SOCKET`. What does survive is the SQLite file
`AGENTMONITORS_DB` pointed at (`/tmp/agentmon-verify-<pid>.db`): `monitor explain` and `monitor
history` both resolve their database via the `AGENTMONITORS_DB` environment variable, so pointing
it at that same file — e.g. `AGENTMONITORS_DB=/tmp/agentmon-verify-<pid>.db agentmonitors monitor
explain <id> --dir .claude/monitors` — reads the persisted state from that run **in-process, no
live daemon required.** (`agentmonitors verify`'s own isolated daemon, by contrast, deletes its
temp database on exit — there's nothing to read back after a plain `verify` run; its own PASS/FAIL
output is the full record. See Phase 6 above for the general debug loop.)
