# Dogfooding: Watching Spec Changes in This Repo

This document describes the committed `incoming-changes` monitor that gives AgentMonitors
maintainers a durable, automatic signal whenever a `git pull` (or local commit) changes the
spec or standard documentation in this repository.

## What it is and where it lives

The monitor is committed at `.claude/monitors/spec-changes/MONITOR.md`. It watches
`docs/specs/**` and `docs/standard/**` for any ref advance on `main`. When one of those
paths changes, the next session surfaces a delivered hook signal summarizing what changed
and whether it affects ongoing work.

The `.gitignore` treats `.claude/monitors/` as untracked by default (so ad-hoc dev
monitors stay local), but explicitly un-ignores `.claude/monitors/spec-changes/MONITOR.md`
so this committed dogfood monitor is tracked by git.

## How to run it

### 1. Build

```sh
pnpm build
```

### 2. Run the daemon from the repo root

```sh
node apps/cli/dist/index.cjs daemon run .claude/monitors --workspace .
```

Running from the repo root is what makes the omitted-`cwd` monitor resolve git against
this repository. The `incoming-changes` source defaults `cwd` to `process.cwd()`, so the
daemon process's working directory determines which git repo is observed. Always start the
daemon from the repo root when using this monitor.

You can also pass `--poll-ms 5000` (or adjust `interval` in the monitor frontmatter) to
control how often the daemon re-checks.

### 3. Open a session (in a second terminal or from your Claude Code hook)

```sh
node apps/cli/dist/index.cjs session open \
  --host-session-id <your-session-id> \
  --workspace .
```

### 4. What you should see

After a `git pull` (or a local commit on `main`) that changes `docs/specs/**` or
`docs/standard/**`, the daemon detects the ref advance on the next tick. The next session
surfaces a delivered signal via the hook-state or MCP channel transport (both already
shipped). When your Claude Code session is at a `turn-interruptible` lifecycle point, the
hook claim returns:

```json
{ "mode": "delivery", "urgency": "normal", "message": "..." }
```

The monitor body instructs the agent to summarize what changed in the spec or standard docs
and assess whether the changes affect the current work in progress.

You can also query pending events directly:

```sh
node apps/cli/dist/index.cjs events list \
  --session <id> --unread --format json
```

## Automated guarantee

The `incoming-changes runtime flow` describe block in
`apps/cli/src/commands/cli.integration.test.ts` is the automated proof of this end-to-end
path (daemon → observe → deliver → claim); literal in-session rendering of the prompt is
covered by the channel/hook transport tests, not this UAT. It:

1. Creates a temp git repo with an initial `docs/specs/001.md` commit on `main`.
2. Starts the daemon pointing at an `incoming-changes` monitor scoped to
   `docs/specs/**` and `docs/standard/**`.
3. Opens a session, waits for the baseline tick (no event), then commits a change to
   `docs/specs/001.md`.
4. Polls until exactly 1 unread event appears, then asserts the hook claim returns
   `mode: 'delivery'` and `urgency: 'normal'`.

Run it with:

```sh
pnpm --filter @agentmonitors/cli exec vitest run \
  src/commands/cli.integration.test.ts \
  -t "incoming-changes runtime flow"
```

## Current vs. target configuration shape

This monitor uses the current `source:` / `scope:` frontmatter, which is the stable,
validated shape supported by the runtime today. The AgentMonitors standard describes a
future intent-first `watch: { type }` authoring syntax (see the Note in issue #40 and
`docs/specs/001-monitor-definition.md` §target). Once that authoring migration lands,
this monitor should be updated to the `watch:` shape. Until then, the current frontmatter
is the correct form to use.
