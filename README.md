# Agent Monitors

**Local-first monitoring for agentic coding tools.** Agent Monitors watches the things you care
about — files, API endpoints, command output, git updates, schedules — and tells your AI coding
agent when they change, at the right moment in its session. Observations are durable, so a signal
isn't lost to a single prompt or a missed hook. Everything runs on your machine; nothing is sent to
a cloud service.

Claude Code is the first supported host.

📖 **Full docs: [agentmonitors.io](https://agentmonitors.io)** ·
[Getting started](https://agentmonitors.io/docs/getting-started) ·
[Notify your agent when a file changes](https://agentmonitors.io/docs/notify-when-a-file-changes)

## Install

Agent Monitors has two pieces: a **CLI** that does the watching, and a **Claude Code plugin** that
delivers signals into your agent sessions automatically.

Requires **Node.js 24 or later** — the only runtime the published packages declare (`engines.node`)
and CI tests.

### 1. Install the CLI

```bash
npm install -g agentmonitors
```

This puts the `agentmonitors` binary on your `PATH`. (Use `npx agentmonitors --help` to try it
without a global install.)

### 2. Add the Claude Code plugin

In Claude Code, add this repo as a plugin marketplace and install the plugin:

```text
/plugin marketplace add mike-north/AgentMonitors
/plugin install agentmonitors@agentmonitors
```

The plugin wires Claude Code's lifecycle hooks to the CLI, so once a project is enabled you don't
have to start daemons or run delivery commands by hand — monitors just show up in your sessions.

## Use it

### Enable monitoring in a project

Monitoring is **off by default** and turned on per project. The quickest way is to ask Claude:

> "Set up Agent Monitors in this project."

That runs the bundled **`setup-monitors`** skill, which walks you through it. To do it by hand,
create a gitignored opt-in file with a small frontmatter block:

```bash
mkdir -p .claude
cat > .claude/agentmonitors.local.md <<'EOF'
---
enabled: true
---
EOF
```

Make sure your `.gitignore` covers `.claude/*.local.*` (this file is per-developer, not committed).
Without it, Agent Monitors stays dormant.

### Author your first monitor

A **monitor** is a `MONITOR.md` file in its own folder under `.claude/monitors/` (or, for a quick
one-off, a flat `<name>.md` file directly in that folder). Scaffold the folder form with `init`:

```bash
agentmonitors init my-first-monitor
# creates .claude/monitors/my-first-monitor/MONITOR.md
```

Edit it. The frontmatter says **what to watch**; the Markdown body is the instruction your agent
receives when it fires:

```yaml
---
name: Config file watcher
watch:
  type: file-fingerprint
  globs:
    - '*.config.ts'
    - 'tsconfig.json'
---
Config files changed. Review the diff, check whether it affects build output
or dependencies, and update any documentation that references the changed config.
```

The monitor's **ID is its folder name** (`my-first-monitor`) — or the filename for a flat monitor. A
monitor needs only a `watch:` block
and a body — everything else is optional. Add `urgency: high` when you want a change to **interrupt**
the agent mid-session; the default (`normal`) surfaces it at the next natural turn boundary.

That's it. With the project enabled and the plugin installed, the agent gets told when your config
files change. For a complete, copy-pasteable walkthrough that proves delivery end to end, see
**[Notify your agent when a file changes](https://agentmonitors.io/docs/notify-when-a-file-changes)**.

### Check your work (optional)

```bash
agentmonitors validate .claude/monitors          # does it parse? is the watch config valid?
agentmonitors scan .claude/monitors              # list every monitor discovered under a root
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md   # dry-run the source
```

## What you can watch

Five observation sources ship in the box — pick one with `agentmonitors init <name> --type <source>`:

| `--type`           | Fires when…                                                 | Key config                                                      |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `file-fingerprint` | local files matching globs are created, changed, or deleted | `globs` (string or list); optional `ignore`                     |
| `api-poll`         | an HTTP endpoint's response changes                         | `url`; `text-diff`/`json-diff`/`status-code`                    |
| `command-poll`     | the output of a command changes                             | `command` (argv, no shell); `text-diff`/`json-diff`/`exit-code` |
| `schedule`         | a cron time arrives                                         | `cron`; optional `timezone`                                     |
| `incoming-changes` | your local git ref advances (e.g. after a pull or merge)    | `paths`; optional `branch`                                      |

See **[Authoring monitors](https://agentmonitors.io/docs/authoring-monitors)** for every source,
urgency band, and notify strategy (debounce / throttle / rollup).

## How it works

A long-running local **daemon** polls each monitor's source, detects change, and records durable
**events** in a local SQLite database. When your agent starts a turn, the plugin's delivery hook
asks for pending work and injects it into the session — with urgency-aware debounce/throttle so you
get signal, not noise. Because events are durable and per-session, nothing is lost across restarts,
reboots, or context compaction.

```text
MONITOR.md ──▶ daemon tick ──▶ source observes change ──▶ durable event ──▶ your agent session
```

## Standalone CLI (without an agent)

You don't need an agent to use the watcher. The daemon and query commands work on their own — handy
for scripts, CI, or just seeing what changed:

```bash
agentmonitors daemon run      # long-running: tick on an interval and serve queries
agentmonitors daemon once     # single tick (good for CI / cron)
agentmonitors events list --session <session-id> --unread   # inspect a session's pending events
```

Run `agentmonitors --help` for the full command surface, or see the
[CLI reference](https://agentmonitors.io/docs) /
[`docs/specs/005-cli-reference.md`](docs/specs/005-cli-reference.md).

## Documentation

- **[agentmonitors.io](https://agentmonitors.io)** — the user docs site (start here): getting
  started, authoring monitors, end-to-end delivery, use cases.
- **[`docs/specs/`](docs/specs/)** — the canonical specification (source of truth for intended
  behavior, marked _current_ vs _target_). Start with the [spec README](docs/specs/README.md). For
  building monitors you rarely need these; they're for deep dives and contributors.

## Contributing

Agent Monitors is a pnpm + Nx monorepo.

```bash
pnpm install
pnpm build      # build all publishable packages
pnpm test       # run all package suites (vitest)
pnpm check      # type-check every package + eslint + prettier
```

To run the CLI from a source checkout without publishing:

```bash
git clone https://github.com/mike-north/AgentMonitors.git
cd AgentMonitors && pnpm install && pnpm build
alias agentmonitors="node \"$(pwd)/apps/cli/dist/index.cjs\""
```

| Package                           | Name                                     | Purpose                                          |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `libs/core`                       | `@agentmonitors/core`                    | Host-agnostic engine: parsing, runtime, delivery |
| `apps/cli`                        | `@agentmonitors/cli` (`agentmonitors`)   | Command surface + the daemon and its IPC         |
| `plugins/source-file-fingerprint` | `@agentmonitors/source-file-fingerprint` | File change-detection source                     |
| `plugins/source-api-poll`         | `@agentmonitors/source-api-poll`         | HTTP polling source                              |
| `plugins/source-command-poll`     | `@agentmonitors/source-command-poll`     | Command (argv) output source                     |
| `plugins/source-schedule`         | `@agentmonitors/source-schedule`         | Cron schedule source                             |
| `plugins/source-incoming-changes` | `@agentmonitors/source-incoming-changes` | Local git-ref advance source                     |
| `agent-plugins/agentmonitors`     | —                                        | The Claude Code plugin (hooks + skill)           |
| `apps/website`                    | —                                        | Public docs site (agentmonitors.io)              |

Changes affecting a published package's behavior or public types should include a
[Changeset](https://github.com/changesets/changesets) (`pnpm changeset`). Full contributor guidance
lives in [CLAUDE.md](CLAUDE.md).

## License

UNLICENSED. © Mike North.
