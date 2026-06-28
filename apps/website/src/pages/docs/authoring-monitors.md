---
title: Authoring Monitors
description: The complete guide to writing MONITOR.md files — the watch model, all bundled sources, urgency, and notify strategies.
---

# Authoring Monitors

## The monitor file

A monitor lives in one of two forms:

```
.claude/monitors/<monitor-id>.md          # flat form — id = filename without .md
.claude/monitors/<monitor-id>/MONITOR.md  # folder form — id = folder name
```

Both forms are equivalent. The folder form (what `agentmonitors init` scaffolds) lets you
keep related assets alongside the monitor. Either way, the **identity is the name** —
a stable machine identifier, not a frontmatter field.

## Frontmatter structure

```yaml
---
name: Human-readable display name  # optional; identity comes from the directory/filename
watch:                              # required — what to observe
  type: <source-type>              # discriminated union tag — always explicit
  # ... source-specific config ...
urgency: high                       # optional — high | normal | low (default: normal)
notify:                             # optional — delivery timing
  strategy: debounce
  settle-for: 5m
---
```

The minimal valid monitor is just a `watch:` block and a body — everything else (`urgency`, `name`,
`notify`, `shape`, `payload`, `baseline-strategy`, `tags`) is optional and reveals itself only when a
specific need calls for it. An omitted `urgency` defaults to `normal`.

> **Want to be notified _during_ a session?** Set `urgency: high`. With the standard Claude Code
> plugin, `high` events are surfaced at the next turn boundary, while the default `normal` (and
> `low`) events are held for the next session's recap rather than interrupting the current one (see
> [Urgency](#urgency)). For "tell me when X changes so I can react now", `high` is the right choice —
> this is the one field worth setting even though it's optional.

## The body: handling instructions

The Markdown body after the frontmatter is delivered verbatim to the agent when the monitor
fires. Write it as a prompt fragment that tells the agent what to do with the signal:

```markdown
---
watch:
  type: file-fingerprint
  globs: ['tsconfig.json', 'package.json']
---

Config files changed. Check whether the change affects build output or
dependencies. Run `pnpm check` to verify type checking still passes. If
package.json dependencies changed, run `pnpm install`.
```

The runtime carries the body through unchanged — it never acts on it. All judgment is
yours, executed by the agent.

## Bundled observation sources

### `file-fingerprint`

Watches local files for content changes using SHA-256 hashing over globs.

```yaml
watch:
  type: file-fingerprint
  globs:
    - 'src/**/*.ts'
    - '*.config.js'
  cwd: /path/to/project   # optional — defaults to the monitors root
```

Uses a **baseline-then-detect** pattern: the first observation establishes the baseline;
subsequent observations diff against it. A single isolated run cannot detect change.

### `api-poll`

Polls an HTTP endpoint and detects response changes.

```yaml
watch:
  type: api-poll
  url: 'https://api.example.com/status'
  method: GET                  # optional — defaults to GET
  interval: 5m                 # optional — polling interval (e.g. 5m, 30s, 1h)
  change-detection:            # optional
    strategy: json-diff        # text-diff (default) | json-diff | status-code
  auth:                        # optional
    type: bearer
    token-env: API_TOKEN       # reads from environment variable
  headers:                     # optional
    Accept: application/json
```

**Change detection strategies:**

| Strategy | Behaviour |
|---|---|
| `text-diff` | Compares raw response body text (default) |
| `json-diff` | Parses JSON and compares semantically (ignores key order and whitespace) |
| `status-code` | Only detects changes in HTTP status code |

**Auth types:**

- **Bearer token:** `type: bearer` with `token` (inline) or `token-env` (env var name)
- **Basic auth:** `type: basic` with `username` and `password` fields

### `command-poll`

Runs a local command on an interval and detects when its output changes — the local-process
sibling of `api-poll`. Use it to watch anything a CLI can report: `git status`, `kubectl get`,
build tooling, a health-check script.

```yaml
watch:
  type: command-poll
  command:                       # argv array, run directly (no shell)
    - git
    - status
    - --porcelain
  interval: 5m                   # optional — polling interval
  change-detection:              # optional
    strategy: text-diff          # text-diff (default) | json-diff | exit-code
  cwd: /path/to/repo             # optional
  timeout: 30s                   # optional — wall-clock limit
```

`command` is an **argv array**, spawned directly with no shell — what you write is exactly what
runs, with no word-splitting, globbing, or injection surface. To use a **pipeline or other shell
operators**, spawn a shell explicitly in argv form:

```yaml
watch:
  type: command-poll
  command: ['sh', '-c', 'git status -sb | grep ahead']   # the supported pipeline idiom
  change-detection:
    strategy: json-diff          # use json-diff when the command emits JSON, e.g. curl | jq
```

Use `strategy: json-diff` when the output is JSON (compares semantically, ignoring key order and
whitespace); `text-diff` (the default) for plain text; `exit-code` to fire only when the exit code
changes.

### `schedule`

Fires on a cron schedule — no change-detection, purely time-driven.

```yaml
watch:
  type: schedule
  cron: '0 9 * * 1-5'          # weekdays at 9 AM
  timezone: America/New_York    # optional — defaults to UTC
  label: Daily standup reminder # optional — custom display title
```

### `incoming-changes`

Fires when a `git pull` or merge advances the commit graph and touches the specified paths.
Unlike `file-fingerprint`, this keys off **commit provenance** — you know the change came
from someone else's push, not your own edit.

```yaml
watch:
  type: incoming-changes
  paths:
    - 'docs/specs/**'
  branch: main                  # optional — defaults to current branch
```

## Urgency

`urgency` controls how — and how urgently — the runtime surfaces the signal to the agent. It is
**optional and defaults to `normal`**; set it explicitly when you want to interrupt the current
session (`high`) or stay quietest (`low`).

| Value | Delivery behaviour (standard Claude Code plugin) |
|---|---|
| `high` | Surfaced **during the session**, at the next turn boundary, after a 15 s settle window. Choose this for "tell me when X changes so I can react now." |
| `normal` | Held and surfaced in the **next session's startup recap** rather than interrupting the current turn. Choose this for background changes the agent should know about but needn't act on immediately. |
| `low` | Same as `normal` but lowest priority — quietest. |

```yaml
urgency: high   # or normal, or low
```

`urgency` also accepts an **escalation band** `lo..hi` (e.g. `normal..high`) — the low bound is the
default level and the high bound is the ceiling a source's per-observation salience may escalate to
(for example, `file-fingerprint` raises a file *deletion* to `high`). A bare level like `normal` is
just the degenerate band `normal..normal`. Bands are an advanced control; reach for one only when you
want a source to be able to raise urgency on its own.

> **Why this matters for the simplest case.** If you want the agent to be notified *mid-session* the
> moment a file or command output changes, use `urgency: high`. `normal`/`low` changes are real and
> durable — queryable any time via `agentmonitors events list` and replayed in the next session's
> recap — but the standard plugin's turn-boundary hook (`agentmonitors hook deliver` on
> `UserPromptSubmit`) injects only **settled high-urgency** events into the running turn; it emits
> nothing for `normal`/`low`, so those do not interrupt the current session. (A lightweight "messages
> pending" reminder for `normal` is available on demand via `agentmonitors hook claim`, but the
> standard plugin does not auto-inject it mid-turn.)

## Notify strategies

The `notify:` block controls delivery timing. Omit it for immediate delivery.

### Debounce

Wait for a quiet period before notifying. Good for rapid-fire events like file saves:

```yaml
notify:
  strategy: debounce
  settle-for: 5m    # wait 5 minutes of quiet before notifying
```

### Throttle

Notify immediately on first event, then suppress for a cooldown:

```yaml
notify:
  strategy: throttle
  suppress-for: 30m   # notify once, then ignore for 30 minutes
```

### Rollup

Accumulate everything since the last window and deliver it as a single digest on a schedule —
delivery time is the constraint, not change time. Good for a daily summary instead of per-change
pings:

```yaml
notify:
  strategy: rollup
  window: '0 9 * * 1-5'          # cron — when the digest is delivered (weekdays at 9 AM)
  timezone: America/Los_Angeles   # optional — defaults to UTC
```

Pair `rollup` with a relaxed `watch.interval` (e.g. `1h`) — there is no benefit to polling every
30 s when delivery is once a day.

## Progressive disclosure

The design rule: simple stays simple, power reveals only when a real need calls for it. Reach for
each field in this order, and only when its specific friction shows up:

1. **Start minimal** — `watch:` (what to observe) and a body (what to do). This is enough for the
   great majority of monitors. Add `urgency: high` here too if you want to be interrupted
   mid-session (the default `normal` waits for the next session's recap).
2. **`notify:`** — when a monitor fires too often. Add `debounce` to wait for quiet, `throttle` to
   cap frequency, or `rollup` to batch into a scheduled digest. (See [Notify strategies](#notify-strategies).)
3. **`shape:`** — when the agent shouldn't have to recompute facts from raw data. Declare derived
   facts (e.g. `past-due`, `urgent`) so the diff is over meaning, not noise.
4. **`payload:`** — when the recipient needs a specific delivery form (`structured` JSON for a
   computing agent, `prose` for a human-readable digest) rather than the default text.
5. **`baseline-strategy:`** — when an agent rejoining after a gap needs the full play-by-play
   (`incremental`) instead of the default net diff (`net`).

Each step is independent; you never need a later one to use an earlier one. Start at step 1 and stop
as soon as the monitor does what you want.

See the [use cases](/docs/use-cases) page for real patterns across this spectrum.

## Validate

```bash
agentmonitors validate .claude/monitors
```

## Verify delivery

Validation proves the monitor is well-formed. Delivery verification proves the agent will actually
see a notification in a session. For a quick test, temporarily set `watch.interval: 5s` and
`urgency: high`, then restore the intended interval after verification. If you start a daemon
manually, use a low poll interval too:

```bash
agentmonitors daemon run .claude/monitors --poll-ms 1000
```

The normal plugin-style path does not require custom sockets. Each recipe below writes a temporary
monitor, validates it, starts a session with the same hook command Claude Code runs, changes the
watched input, and then asks the hook transport for pending delivery.

### `command-poll` recipe

Use a scratch input file so you can induce a real command-output change.

```bash
mkdir -p .claude
cat > .claude/agentmonitors.local.md <<'EOF'
---
enabled: true
---
EOF

mkdir -p .claude/monitors/verify-command
printf 'before\n' > .agentmonitors-command-state.txt

cat > .claude/monitors/verify-command/MONITOR.md <<'EOF'
---
name: Verify command-poll delivery
watch:
  type: command-poll
  command:
    - cat
    - .agentmonitors-command-state.txt
  interval: 5s
urgency: high
---

Command output changed. Inspect the new state and decide whether action is needed.
EOF

agentmonitors validate .claude/monitors

export SESSION_ID="verify-command-$(date +%s)"
printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart"}' "$SESSION_ID" "$PWD" \
  | agentmonitors session start

sleep 10  # Let the first command-poll observation establish its baseline.
printf 'after\n' > .agentmonitors-command-state.txt
sleep 25

printf '{"session_id":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$SESSION_ID" "$PWD" \
  | agentmonitors hook deliver
```

### `api-poll` recipe

Point the monitor at a controllable endpoint. This example serves a scratch JSON file locally and
then changes the response.

```bash
mkdir -p .claude
cat > .claude/agentmonitors.local.md <<'EOF'
---
enabled: true
---
EOF

mkdir -p .claude/monitors/verify-api
printf '{"status":"before"}\n' > .agentmonitors-api-response.json
python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/agentmonitors-api.log 2>&1 &
SERVER_PID=$!

cat > .claude/monitors/verify-api/MONITOR.md <<'EOF'
---
name: Verify api-poll delivery
watch:
  type: api-poll
  url: 'http://127.0.0.1:8765/.agentmonitors-api-response.json'
  interval: 5s
  change-detection:
    strategy: json-diff
urgency: high
---

API response changed. Inspect the new response and decide whether action is needed.
EOF

agentmonitors validate .claude/monitors

export SESSION_ID="verify-api-$(date +%s)"
printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart"}' "$SESSION_ID" "$PWD" \
  | agentmonitors session start

sleep 10  # Let the first api-poll observation establish its baseline.
printf '{"status":"after"}\n' > .agentmonitors-api-response.json
sleep 25

printf '{"session_id":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$SESSION_ID" "$PWD" \
  | agentmonitors hook deliver

kill "$SERVER_PID" 2>/dev/null || true
```

Success is a JSON object whose `hookSpecificOutput.additionalContext` contains the monitor body. To
also confirm the event reached the session, list unread events for the AgentMon session:

```bash
AGENTMON_SESSION_ID="$(agentmonitors session list --format json \
  | node -e 'let input=""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => { const sessions = JSON.parse(input); const match = sessions.find(s => s.hostSessionId === process.env.SESSION_ID); if (!match) process.exit(1); console.log(match.id); });')"
agentmonitors events list --session "$AGENTMON_SESSION_ID" --unread
```

For resources you do not control, such as a live third-party API or a remote repository, you can
confirm authoring and connectivity with `agentmonitors monitor test <path/to/MONITOR.md>`, but a
real delivery requires the external resource to change. Use a controllable scratch endpoint or input
when you need proof immediately.

## Generate a JSON Schema for editor autocompletion

```bash
agentmonitors schema generate -o monitor-schema.json
```

Point your editor at the generated file to get inline validation and autocomplete while
authoring monitors.
