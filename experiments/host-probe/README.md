# Host probe (generalized binding-probe harness)

Generalizes [`experiments/channel-probe`](../channel-probe/README.md) into a reusable, per-host
diagnostic required by [`docs/specs/006-agent-integration.md`](../../docs/specs/006-agent-integration.md)
§11.6: before a host's cells in the §11.3 adapter matrix move from _(probe)_ to _current_, a probe run
must pin the **session-identity signal**, the **workspace-binding signal**, and **which lifecycle hook
points fired** — and commit the artifact as evidence.

This is not product code. It is a diagnostic tool that records what a host session actually gives it,
honestly — including absences.

## What it records

Run inside a target host session, `probe.mjs` has two "sighting" sources:

- **`record-hook`** — a lifecycle-hook command (wired into the host's hook config, one entry per
  event you want to observe). Reads the hook's stdin JSON payload and records whatever
  session-identity (`session_id`) and workspace (`cwd`) fields it finds — or their absence.
- **`record-mcp`** — a spawned stdio MCP server (the "richer, additive transport" analogue, §11.1
  dimension 6). Records its environment (filtered to identity/workspace-shaped keys) and attempts
  `roots/list`.

`summarize` reduces the JSONL sightings from both sources into one matrix-cell JSON artifact:
`host`, `surface`, `hostVersion`, `sessionIdentitySignal`, `workspaceBindingSignal`,
`lifecycleHookPointsFired`, and `richerTransport`.

## Setup

```bash
cd experiments/host-probe
npm install            # pulls @modelcontextprotocol/sdk + vitest (standalone npm project,
                        # not part of the pnpm workspace — same pattern as channel-probe)
```

## Run the automated suite (safe, no live host needed)

```bash
npx vitest run --config vitest.config.ts
```

This covers the harness's own parsing/reduction logic against the documented stdin contract
(006 §5.0) and MCP env contract (§4.4) with synthetic-but-spec-accurate payloads, plus an
integration layer that spawns the real `probe.mjs` binary and pipes real stdin JSON into it — the
same way a host hook actually invokes a command. It does **not** require a live Claude Code (or
other host) session; that part is the manual runbook below.

## Runbook: probing a live host session

### 1. Scaffold a throwaway project

Create a temp directory with the host's hook config wired to `record-hook`, and (if the host
supports MCP servers) an MCP config wired to `record-mcp`. Both commands accept `--out <path>` for
the shared JSONL artifact file; point every entry at the same path so `summarize` sees everything.

Claude Code example (`.claude/settings.json` + `.mcp.json` in the throwaway project):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
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
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
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
            "command": "node /abs/path/to/experiments/host-probe/probe.mjs record-hook --out /tmp/probe-artifact.jsonl"
          }
        ]
      }
    ]
  }
}
```

```json
{
  "mcpServers": {
    "agentmon-host-probe": {
      "command": "node",
      "args": [
        "/abs/path/to/experiments/host-probe/probe.mjs",
        "record-mcp",
        "--out",
        "/tmp/probe-artifact.jsonl"
      ]
    }
  }
}
```

For a **new** host (Codex, Cursor), swap in that host's own hook-config file format and
lifecycle-hook names (§11.1 dimension 1) — the `record-hook` command itself is host-agnostic; it
just reads whatever JSON it is given on stdin and records which fields are present. If the host has
no MCP-server (or MCP-server-equivalent) mechanism, skip `record-mcp` entirely — `summarize` reports
`richerTransport.attempted: false` honestly rather than guessing.

### 2. Drive a real session

```bash
cd /tmp/probe-project
claude -p "call the agentmon-host-probe MCP server's probe tool, then run: echo probe-ok" \
  --dangerously-skip-permissions --setting-sources project \
  --mcp-config .mcp.json --strict-mcp-config
```

Adjust for the target host's own non-interactive/print mode. The goal is just to exercise a normal
turn (prompt → tool call → stop) so every wired hook fires at least once.

### 3. Summarize

```bash
node probe.mjs summarize \
  --in /tmp/probe-artifact.jsonl \
  --host <host-id> --surface <cli|desktop> --host-version "<exact version string>" \
  --note "<anything a reader needs to interpret this run honestly — caveats, what wasn't exercised>" \
  --out results/<host-id>-<surface>-baseline.json
```

Also copy the raw `--in` JSONL next to the summary (`results/<host-id>-<surface>-baseline-sightings.jsonl`)
so a reader can see the individual sightings the summary was reduced from, not just the reduction.

### 4. Commit the artifact as evidence

Commit both files under `experiments/host-probe/results/`. The §11.3 matrix's _(probe)_ cells for
that host/surface reference these artifacts as the pinning evidence required by §11.6. **Always
record absences honestly** — a signal that was not observed (env var unset, hook never fired,
`roots/list` unsupported) is real, useful data; do not omit it or infer a value that was not
actually seen.

## Known limitations of this baseline pattern

- `record-mcp`'s channel-push notification (the richer-transport push itself, distinct from the
  MCP-server env/roots signals) may be silently dropped if the host's channel/push feature is
  research-preview-gated or off — see [`results/claude-code-cli-baseline.json`](./results/claude-code-cli-baseline.json)'s
  `notes` for exactly what could/couldn't be independently reconfirmed on the run that produced it.
- A short, single-turn `-p`/print-mode session cannot exercise idle- or compaction-triggered
  lifecycle hooks (Claude's `TeammateIdle`/`PreCompact`/`PostCompact`); a fuller probe needs a
  longer-lived or `--resume`d session. Note this explicitly in the artifact's `notes` rather than
  silently reporting those hook points as unfired-and-therefore-absent.

## Teardown

Throwaway. `experiments/host-probe/` itself is committed (per spec 006 §11.6, this harness and its
committed artifacts are the required evidence), but any scratch project directories created under
step 1 above are not — delete them when done.

## Artifact hygiene

Before committing a probe artifact, redact identifying values: replace the home directory in any
absolute path with `/Users/<user>` (or `<HOME>`) and each session UUID with a stable placeholder
(`<session-1>`, `<session-2>`, …; keep the mapping consistent within one probe run). The matrix
evidence needs key presence, mechanisms, and hook shapes — never real ids or personal paths.
