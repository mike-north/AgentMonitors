---
title: Getting Started
description: Install Agent Monitors, author your first monitor, and see a signal in minutes.
---

# Getting Started

## Install

Install the CLI globally from npm:

```bash
npm install -g @agentmonitors/cli
```

Or use it without a global install:

```bash
npx @agentmonitors/cli --help
```

### From source (development)

```bash
git clone https://github.com/mike-north/AgentMonitors.git
cd AgentMonitors
pnpm install
pnpm build
alias agentmonitors="node \"$(pwd)/apps/cli/dist/index.cjs\""
```

## Scaffold your first monitor

The `init` command creates a ready-to-edit `MONITOR.md` in your project's monitors folder:

```bash
agentmonitors init my-first-monitor
```

This creates `.claude/monitors/my-first-monitor/MONITOR.md`. By default it scaffolds a
`file-fingerprint` monitor:

```yaml
---
name: My monitor
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
urgency: normal
---

When changes are detected, review and take appropriate action.
```

> **A quick note on `urgency` — it controls _when_ you're notified, not just how important the
> change is:**
>
> - `high` surfaces **mid-session**, at the next turn boundary, after a **15 s** settle window (deliberate — not instant) — with
>   the full event content (title, summary, and body).
> - `normal` (the default above) also surfaces mid-session, but only as a single generic reminder
>   covering the whole unread batch, then stays quiet until you acknowledge it — no per-event
>   detail.
> - `low` surfaces that same generic reminder, but only once the agent goes idle.
>
> Use `high` to be interrupted with the specifics.

You can scaffold other source types with `--type`:

```bash
agentmonitors init api-watcher --type api-poll
agentmonitors init git-status --type command-poll
agentmonitors init spec-watcher --type incoming-changes
```

## Edit the monitor body

The markdown body after the frontmatter is the handling instruction the agent receives when
the monitor fires. Write it as a prompt fragment:

```yaml
---
name: Config file watcher
watch:
  type: file-fingerprint
  globs:
    - '*.config.ts'
    - 'tsconfig.json'
urgency: normal
---
Config files changed. Review the diff, check whether the change affects
build output or dependencies, and update any documentation that references
the changed configuration.
```

## Validate

Check that your monitor parses correctly and its source configuration is valid:

```bash
agentmonitors validate .claude/monitors
```

## Test the observation source

Dry-run the source against your filesystem to confirm it can observe:

```bash
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md
```

> **Note:** `file-fingerprint` and `api-poll` use a baseline-then-detect pattern. The first
> run establishes the baseline; `monitor test` runs a second observation automatically so
> you can see the change-detection in action. For daemon delivery, `file-fingerprint`
> re-checks files on a ~30s observe interval by default; set `watch.interval` to tune that cadence.

## Scan all monitors

Get an overview of every monitor under a root — useful to verify discovery:

```bash
agentmonitors scan .claude/monitors
```

## Start the daemon

The daemon ticks on an interval, observes each source, and materialises durable events:

```bash
agentmonitors daemon run
```

For a single tick (useful in CI or scripts):

```bash
agentmonitors daemon once
```

## Get notified in an agent session

The daemon records durable events, but an agent is notified only after a session is registered and a
delivery hook asks for pending work. In normal Claude Code use, the Agent Monitors plugin handles
that wiring for you:

- `SessionStart` runs `agentmonitors session start` to register the session and boot the
  per-project daemon.
- `UserPromptSubmit` runs `agentmonitors hook deliver` to inject pending monitor context into the
  agent turn.

### First checkpoint: `agentmonitors doctor`

Before verifying end-to-end delivery, get a fast read on what's wired up and what isn't:

```bash
agentmonitors doctor
```

It runs a handful of named checks — project enabled, monitors valid, daemon reachable, a lead
session registered, plus a per-monitor rollup — and tells you exactly which stage is missing. It's
normal to see several checks fail right now (you haven't enabled the project or started a daemon
yet). The next section's default `agentmonitors verify` run won't turn these green either — by
design it boots and tears down its own throwaway daemon that `doctor` never looks at. Pass
`--use-workspace-daemon` (see below) if you want a `verify` run that also leaves `doctor` green
afterward.

### Prove it, right now

This is the check that actually matters: not "does the config parse" but "does my agent get
notified." `agentmonitors verify` runs the whole daemon → session → trigger → event → delivery
pipeline in one command and prints a single PASS or FAIL:

```bash
agentmonitors verify my-first-monitor
```

`verify` boots an isolated daemon on a throwaway socket and database, registers a throwaway
session, triggers a real change (for `file-fingerprint`, by writing a scratch file that matches
the monitor's `watch.globs`), waits for the event to materialize, and claims it through the same
delivery path a live hook would use — then tears everything down. There's no socket to pick, no
database to scratch-isolate, no `trap` cleanup, and no poll loop to size by hand: `verify` derives
its own wait budget from the monitor's own `watch.interval` and `notify.settle-for` and prints
elapsed/ETA progress to stderr, so you're never left staring at silence (spec 005 §16, "Budget").

**Success looks like:**

```
agentmonitors verify: my-first-monitor

  ✓ daemon      booted on /tmp/agentmon-verify-xxxxxx/d.sock
  ✓ session     registered lead session <id>
  ✓ baseline    first observation recorded
  ✓ trigger     wrote scratch file agentmonitors-verify-xxxxxx.ts
  ✓ observe     change detected (triggered)
  ✓ materialize 1 unread event(s)
  ✓ deliver     claimed at post-compact

PASS  my-first-monitor delivers end-to-end (34.2s)

Delivered additionalContext:
  AgentMon: monitored changes are pending — consider handling them before continuing.

  ### my-first-monitor
  ...
```

Exit code `0` means PASS; a non-zero exit and a `FAIL` line name the exact stage that failed
(`daemon`, `session`, `baseline`, `trigger`, `observe`, `materialize`, or `deliver`) instead of
leaving you to guess from empty output. `--format json` prints the same result as a stable machine
shape.

A few flags worth knowing:

- **`--manual`** — today only `file-fingerprint` gets a fabricated trigger, and only when its
  glob has a derivable matching path. For any other source (or a `file-fingerprint` glob whose
  filename segment is itself a wildcard, e.g. `file-?.md`), pass `--manual` and `verify` prompts
  you to make the change yourself, then watches for it. **`--manual` blocks for the wait window and
  does _not_ read stdin** — it is not an interactive prompt. A human switches windows and edits a
  file; an agent with a persistent shell backgrounds the run and makes the change in a separate
  step. An agent whose harness runs one shell command per step (call-and-return) can't do either, so
  it should use `--trigger-cmd` (next) instead.
- **`--trigger-cmd '<shell>'`** — the **recommended path for non-interactive / call-and-return
  agents** and for any source `verify` can't auto-trigger (`command-poll`, `api-poll`, `schedule`,
  `incoming-changes`). Instead of waiting for you, `verify` runs this shell command itself (after
  baseline, from the workspace directory) to cause the watched change, then observes and delivers —
  a single self-contained command, just like the file-fingerprint auto-trigger. For a `command-poll`
  watching `git status --porcelain`, for example, pass `--trigger-cmd 'touch new-file.txt'`. The
  command's effects are _not_ reverted (an arbitrary command has no known inverse), so pick one whose
  residue is acceptable; a non-zero exit is reported as a `setup` failure so you fix the command, not
  the monitor. `--manual` and `--trigger-cmd` are mutually exclusive.
- **`--use-workspace-daemon`** — for a proof you can screenshot for a stakeholder (e.g. showing a
  reviewer that monitoring is actually wired up), add this flag. It runs `verify` against your
  project's real daemon/database instead of a throwaway one, and leaves it running afterward, so a
  follow-up `agentmonitors doctor` reflects the delivery directly instead of resolving a throwaway
  isolated daemon. This requires the project to already be enabled — see **step (a)** in the
  appendix below for the one-time opt-in. Because that daemon persists, `verify` cleans up its own
  scratch file so the throwaway change never surfaces to a real session; it does this without
  waiting, so this mode finishes in about the same time as a plain `verify`, and an interrupted run
  leaves nothing stray behind.
- **`--timeout-ms`** — overrides the derived post-trigger detection budget, if you need more time
  than what `verify` estimates.

See the `verify` command reference (spec 005 §16) for the full flag table.

Once you're satisfied a monitor delivers, revert any `interval` / `settle-for` shortcuts you made
just to speed up testing.

---

## Appendix: Advanced — manual, host-agnostic verification

`agentmonitors verify` above covers the common case. This appendix drives the exact same
daemon → session → event → delivery pipeline **by hand, one step at a time**, with an explicit
socket so nothing here depends on a live Claude Code session or the workspace's own daemon. Reach
for it when you want to inspect an individual pipeline stage, debug a `verify` failure at the
protocol level, or work against a source `verify` can't auto-trigger without `--manual`. Run every
command from the project root.

**a. Enable the project.** This one-time, gitignored opt-in file is required — without it,
`hook deliver` always emits nothing, even with `--socket`. Check `agentmonitors init --help` for
an `--enable-only` flag first — if it's listed, it's the one-command way to do this:

```bash
agentmonitors init --enable-only
```

This creates `.claude/agentmonitors.local.md` and updates `.gitignore` for you, with no monitor
and no prompts. **If `--enable-only` isn't listed** (older CLI version), create an equivalent enable file by
hand:

```bash
mkdir -p .claude
cat > .claude/agentmonitors.local.md <<'EOF'
---
enabled: true
---
EOF
```

Make sure `.gitignore` contains `.claude/*.local.*` and `/.agentmonitors/` (the daemon's
per-session runtime-state directory, created the moment a session opens — it's regenerated on
every run, so it's always safe to delete).

**b. Speed up the monitor and set it to `high` urgency, for this pass only.** This is what lets you
see the real delivered content instead of just the mechanism firing (see the urgency note above).
Edit `.claude/monitors/my-first-monitor/MONITOR.md`:

```yaml
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
  interval: 5s # shorten for this test only
notify:
  strategy: debounce
  settle-for: 5s # shorten for this test only
urgency: high
```

**c. Run the recipe.** `file-fingerprint` baselines silently on its first-ever tick: whatever files
exist at that moment become the reference point, and nothing is reported as changed. That first
tick runs immediately when the daemon starts (before waiting `--poll-ms` at all), so the recipe
below first seeds `example.ts` with placeholder content, *then* starts the daemon so that first
tick baselines the file as already existing, and only *then* waits a full poll interval before
changing it — that ordering guarantees the trigger is a genuine content change of an
already-baselined file, not a first-time creation. **`file-fingerprint` detects changes by content
hash, not mtime or existence** — a bare `touch` on a file whose content doesn't change leaves the
hash unchanged and is silently ignored, so the trigger below appends real content instead:

```bash
CWD=$(pwd)
HOST_ID="verify-$(date +%s)"
SOCKET="/tmp/agentmon-verify-$$.sock"
# Isolate this recipe's runtime state from any other daemon on the machine
# (and from a previous run of this same recipe).
export AGENTMONITORS_DB="/tmp/agentmon-verify-$$.db"

# 1. Seed the file the monitor's `**/*.ts` glob watches, so it already exists
#    (with stable content) before the daemon's baselining first tick runs.
echo "// baseline" > example.ts

# 2. A daemon pinned to this socket that never idle-reaps.
agentmonitors daemon run .claude/monitors --socket "$SOCKET" --reap-after-ms 0 --poll-ms 5000 &
DAEMON_PID=$!
# Clean up the daemon even if a later step fails or you Ctrl-C out.
trap 'kill "$DAEMON_PID" 2>/dev/null' EXIT
sleep 1

# 3. A lead session on the same socket — capture its id (it is NOT $HOST_ID).
# --format id prints just the bare id, no JSON parsing needed.
AGENTMON_SESSION_ID=$(agentmonitors session open --socket "$SOCKET" --host-session-id "$HOST_ID" \
  --role lead --workspace "$CWD" --format id)

# 3b. Wait a full poll interval (matching --poll-ms above) so the daemon's
# first, baselining tick has definitely already run before we change example.ts.
sleep 5

# 4. Trigger the watched change. A bare `touch` is a silent no-op under
#    file-fingerprint's content-hash comparison — append real content instead.
echo "// verify $(date)" >> example.ts

# 5. Poll until the event materializes (events list needs a reachable daemon).
# This loop's 20 x 2s = 40s budget assumes step (b)'s shortened `interval: 5s`
# and `settle-for: 5s`. Size it to `interval + settle-for` for whatever values
# you're actually running with — the same formula step 6 budgets for
# `hook deliver`, one stage later (+ its own fixed ~15s claim-settle). At
# file-fingerprint's unshortened 30s default interval, a fixed 40s loop can
# run out before the event ever materializes, with no error — just an empty
# `[]`; widen the retry count instead of assuming something's broken.
for i in $(seq 1 20); do
  OUT=$(agentmonitors events list --socket "$SOCKET" --session "$AGENTMON_SESSION_ID" --unread --format json)
  [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$OUT")" -ge 1 ] && break
  sleep 2
done
echo "$OUT"

# 6. Simulate the UserPromptSubmit hook Claude Code sends on every turn. Empty
# stdout usually means nothing was claimable yet — poll like step 5 does. But
# empty stdout is also how several misconfigurations look (workspace not
# enabled, daemon unreachable, ...), so if the loop never returns content, run
# `agentmonitors hook deliver --debug` (writes a step-by-step diagnosis to
# stderr) to tell the two apart.
for i in $(seq 1 20); do
  OUT5=$(echo "{\"session_id\":\"$HOST_ID\",\"cwd\":\"$CWD\",\"hook_event_name\":\"UserPromptSubmit\"}" \
    | agentmonitors hook deliver --socket "$SOCKET")
  [ -n "$OUT5" ] && break
  echo "(hook deliver: nothing claimable yet, retrying...)" >&2
  sleep 2
done
echo "$OUT5"

# 7. Clean up.
kill "$DAEMON_PID"
```

**Success looks like:** step 5 prints an event row for `example.ts`, and step 6 prints a JSON object
whose `hookSpecificOutput.additionalContext` is non-empty and names your monitor — that's exactly
what a live Claude Code turn would receive.

If step 5 or step 6's loop keeps retrying, don't assume it's just a settle window — check what the
daemon actually recorded first:

```bash
agentmonitors monitor history my-first-monitor --socket "$SOCKET"
```

A row whose result column shows `no-change` means the trigger in step 4 didn't actually alter
anything the source could detect (e.g. a `touch` on a file whose content didn't change) — fix the
trigger, don't keep waiting. A row showing `suppressed` means the opposite: the trigger worked and
the source detected a real change, but a debounce/settle (or rollup) hold in `notify:` is delaying
it from becoming an event yet — that's expected mid-settle, not a broken trigger; wait for the
next tick, or check `monitor explain`'s notify stage. Only once the result column shows `triggered`
is a still-empty step 6 loop expected for `high` urgency, not a bug: `hook deliver` applies its own
fixed ~15s "claim settle" window measured from the event's creation time, separate from
`notify.settle-for`. The 20 × 2s retry window above comfortably covers that once the event actually
exists.

Once you're done, revert the `interval` / `settle-for` / `urgency` edits from step (b) to whatever
fits your real use case.

**A red `doctor` right after this succeeds is expected, not a bug.** Steps (a)–(c) ran entirely
against the isolated `$SOCKET` / `$AGENTMONITORS_DB` above; `agentmonitors doctor` (and `monitor
explain`) auto-discover the *workspace's own* socket and database — falling back to the shared
global default only when the workspace isn't enabled — so neither ever resolves this recipe's
throwaway `$SOCKET` (both still honor `AGENTMONITORS_DB` if it's set in their environment). To see
the real setup an actual agent session would use, start a daemon on the workspace's own socket
(`agentmonitors daemon run` — no `--socket`) or open a live Claude Code session, then re-run
`doctor`.

**For a stakeholder-presentable proof**, don't screenshot this appendix's isolated-socket output —
it's throwaway and proves the mechanism, not the live setup. Use
`agentmonitors verify --use-workspace-daemon` instead (see "Prove it, right now" above) and
screenshot its PASS output alongside `doctor`'s all-green summary.

For the same proof wired through the real Claude Code plugin instead of a manual socket, see
[Notify your agent when a file changes](/docs/notify-when-a-file-changes).

## Inspect session events

Event inspection is session-scoped. After a session exists, pass its id explicitly:

```bash
agentmonitors events list --session <session-id> --unread
```

The appendix's step (c) shows the session setup path. Use this command any time you want to
inspect what a registered session still has unread; use `hook deliver` when you want to verify
what the agent actually receives.

## Next steps

- [Notify your agent when a file changes](/docs/notify-when-a-file-changes) — end-to-end delivery
  verification
- [Authoring monitors](/docs/authoring-monitors) — all sources, urgency levels, notify strategies
- [Agent integration & delivery](/docs/agent-integration) — how hooks and the optional MCP channel
  deliver into a session, and how to run entirely without MCP
- [CLI reference](/docs/cli-reference) — every command, its flags, and output formats
- [Use cases](/docs/use-cases) — patterns from simple file-watching to fleet supervision
- [Troubleshooting](/docs/troubleshooting) — symptom-first fixes when a monitor doesn't fire or
  doesn't notify

Using an AI coding agent to do this setup? Point it at
[agentmonitors.io/skill.md](/skill.md) instead — a self-contained, agent-readable version of this
guide that installs the CLI, authors a monitor, and proves it fires on its own.
