---
title: Notify your agent when a file changes
description: A complete, verified walkthrough — from zero to your Claude Code agent being notified during a session whenever a chosen file changes.
---

# Notify your agent when a file changes

This is the end-to-end path for the most common monitor: **your agent gets notified during a
session whenever a chosen file changes.** It picks up where [Getting Started](/docs/getting-started)
leaves off — covering the delivery half (sessions, urgency, and how the notification actually
reaches the agent), not just authoring a monitor.

In normal use the **agentmonitors Claude Code plugin** runs the lifecycle hooks for you, so once
this is set up, delivery is automatic — there is no daemon to babysit. This guide sets that up and
then runs the *same commands the plugin runs* so you can verify it works right now.

Run every command from the project root. We'll watch a file called `notes.md`.

## 1. Enable monitoring in this project

Create `.claude/agentmonitors.local.md`. This opt-in is required — without it the session hook
quietly does nothing:

```markdown
---
enabled: true
---
```

Make sure `.gitignore` contains `.claude/*.local.*`.

## 2. Author the monitor

Scaffold it (don't hand-write the frontmatter), then point it at your file and make it **high
urgency** — this is the important part:

```bash
agentmonitors init watch-file --type file-fingerprint --dir .claude/monitors
```

Edit `.claude/monitors/watch-file/MONITOR.md` so it reads:

```yaml
---
name: Watch notes.md
watch:
  type: file-fingerprint
  globs:
    - 'notes.md'        # the file (or glob) to watch, relative to the project root
urgency: high           # required for mid-session notification — see note below
---

notes.md changed. Review what changed and react if it affects current work.
```

If the action you expect the agent to take writes files that also match the watched glob, exclude
those outputs. Otherwise the monitor can detect its own notification artifact and fire again:

```yaml
watch:
  type: file-fingerprint
  globs:
    - '**/*.txt'
  ignore:
    - '**/notified-*.txt'
```

The other safe option is to write generated notes outside the watched tree entirely.

> **Why `high`:** mid-session delivery fires for `high`-urgency changes. A `normal` (the scaffold
> default) or `low` change is a quieter signal that may only surface in the recap when a new
> session starts. If you want the agent interrupted *during* a turn when the file changes, use
> `high`.

Validate:

```bash
agentmonitors validate .claude/monitors
```

Expect `Valid monitors: 1`. Fix any reported error before continuing.

## 3. Verify it actually notifies the agent

Run the two commands the plugin runs on your behalf. Both read this project's state from
`.claude/agentmonitors.local.md`, so you do **not** manage sockets, sessions, or daemons by hand.

**a. Start a session** — boots the per-project daemon and registers the session. Feed it a hook
payload on stdin exactly like Claude Code does:

```bash
printf '{"session_id":"verify-1","cwd":"%s","hook_event_name":"SessionStart"}' "$PWD" \
  | agentmonitors session start
```

**b. Change the watched file:**

```bash
printf '\n## a change\n' >> notes.md
```

**c. Wait for detection, then ask for pending notifications.** Detection is not instant: the file
is re-checked on a ~30s interval and a `high` change then settles for ~15s. Worst case the change
lands just after a check, so allow up to ~90s and re-poll if the first attempt is empty. Set
`watch.interval` in the monitor frontmatter to tune the file re-check cadence:

```bash
sleep 50
printf '{"session_id":"verify-1","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
# If empty, wait and try once more:
sleep 40
printf '{"session_id":"verify-1","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
```

**Success looks like** a JSON object on stdout whose `additionalContext` names your file:

```json
{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
"additionalContext":"AgentMon: monitored changes are pending ...### watch-file (high)\nFile changed: .../notes.md\n\nnotes.md changed. Review what changed ..."}}
```

That `additionalContext` is exactly what gets injected into the agent's turn in a real session — so
the agent is notified. If you get **empty output**, the change hasn't been detected yet: wait
another ~30s and re-run command (c). (`hook deliver` consumes the pending delivery, so an immediate
second run is empty even on success — that's expected.)

Once verified, you're done: with the plugin installed, the agent is notified automatically on every
future `high`-urgency change.

## Next steps

- [Authoring monitors](/docs/authoring-monitors) — all sources, urgency levels, notify strategies
- [Agent integration & delivery](/docs/agent-integration) — the full transport model behind the
  `session start`/`hook deliver` commands above, plus running entirely without MCP
- [Use cases](/docs/use-cases) — patterns from simple file-watching to fleet supervision
- [Troubleshooting](/docs/troubleshooting) — what to do if step 3 doesn't produce a notification
