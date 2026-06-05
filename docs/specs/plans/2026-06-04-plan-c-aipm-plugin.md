# Plan C — `aipm` colocated marketplace + the `agentmonitors` activation plugin (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Also load the `marketplace-authoring` skill (it owns the canonical procedure). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the AgentMonitors repo into a colocated AI-plugin marketplace shipping **one** plugin — `agentmonitors` — that registers the lifecycle hooks (SessionStart/PreToolUse/Stop/SessionEnd) and bundles the channel MCP. Install once per host (Claude Code, Codex, Cursor, Gemini, Kiro); drop-in monitors thereafter.

**Architecture:** Use the `@ai-plugin-marketplace` toolkit (`aipm`) per the `marketplace-authoring` skill. Plugin sources live under `agent-plugins/` (our `plugins/` is taken by the `source-*` packages); generated registries are committed and freshness-checked in CI. The plugin's hooks call the `agentmonitors session start`/`session end` commands (Plan B) and the delivery hook (Plan D); `.mcp.json` reuses the existing `channel-plugin/` config.

**Tech Stack:** `@ai-plugin-marketplace/cli` + `core`, pnpm workspace, the existing `channel-plugin/` as the MCP model. This plan is mostly scaffolding + config + CI, not TDD — "done" is `aipm validate` passing and the plugin installing.

**Design source:** [design](../design/2026-06-04-drop-in-monitors-steel-thread.md) §4.1 (distribution as a colocated aipm plugin). Reference: `~/Development/ai-plugin-marketplace/template` (layout) and `tools/agent-plugins/marketplace-authoring` (a real plugin example).

**Depends on:** B (the `session start`/`session end` verbs the hooks call). The delivery hook wiring (Plan D) can be filled in when D lands; scaffold the hook entry now and point it at a placeholder that exits 0, then wire D.

---

## File Structure

| Path                                                                                        | Responsibility                                             | Change                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `aipm.repo.ts`                                                                              | Relocate plugin/dist roots off `plugins/`                  | Create                                   |
| `aipm.workspace.ts`                                                                         | Marketplace metadata (opts into generated registries)      | Create                                   |
| `agent-plugins/agentmonitors/aipm.config.ts`                                                | Support envelope (targets, version, description, keywords) | Create (via `aipm scaffold`)             |
| `agent-plugins/agentmonitors/hooks/claude.yaml`                                             | The lifecycle hooks                                        | Create                                   |
| `agent-plugins/agentmonitors/.mcp.json`                                                     | The channel MCP server                                     | Create (from `channel-plugin/.mcp.json`) |
| `agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md`                                | One-time setup helper skill                                | Create                                   |
| `.claude-plugin/marketplace.json`, `.cursor-plugin/…`, `.agents/…`, `agent-plugins/dist/**` | Generated registries + bundles                             | Generated (committed)                    |
| `package.json`                                                                              | aipm devDeps + scripts                                     | Modify                                   |
| `.prettierignore`                                                                           | Exclude generated marketplace paths                        | Modify                                   |
| `.github/workflows/*`                                                                       | Wire `aipm validate`                                       | Modify                                   |
| `channel-plugin/`                                                                           | Folded into the new plugin                                 | Remove/redirect                          |
| `.gitignore`                                                                                | Ensure `.claude/*.local.md` ignored                        | Modify                                   |

---

## Task 1: Add the toolkit and declare the embedded marketplace

**Files:** `package.json`, `aipm.repo.ts` (create), `aipm.workspace.ts` (create)

- [ ] **Step 1: Add the toolkit as a dev dependency**

Run: `pnpm add -D -w @ai-plugin-marketplace/cli @ai-plugin-marketplace/core`
Expected: both resolve and install at the workspace root.

- [ ] **Step 2: Declare the embedded layout**

Create `aipm.repo.ts` at the repo root:

```ts
import { defineRepoConfig } from '@ai-plugin-marketplace/core';

// `plugins/` is the source-plugin packages; relocate the agent-plugin marketplace.
export default defineRepoConfig({
  pluginsRoot: 'agent-plugins',
  distDir: 'agent-plugins/dist',
});
```

- [ ] **Step 3: Declare the marketplace**

Create `aipm.workspace.ts` at the repo root:

```ts
import { defineWorkspace } from '@ai-plugin-marketplace/core';

export default defineWorkspace({
  marketplace: {
    name: 'agentmonitors',
    owner: { name: 'Mike North' },
    description:
      'Drop-in monitors for agentic coding tools — install once, then drop markdown monitor files into .claude/monitors.',
  },
});
```

- [ ] **Step 4: Verify the toolkit sees the config**

Run: `pnpm exec aipm validate`
Expected: it runs (likely reporting "no plugins yet" or a clean pass) — confirms `aipm.repo.ts`/`aipm.workspace.ts` are read. Capture the exact finding; if it errors on a missing plugin, that's resolved by Task 2.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml aipm.repo.ts aipm.workspace.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Embed an aipm marketplace in the repo (pluginsRoot: agent-plugins)"
```

---

## Task 2: Scaffold and author the `agentmonitors` plugin

**Files:** `agent-plugins/agentmonitors/**`

- [ ] **Step 1: Scaffold**

Run: `pnpm exec aipm scaffold agentmonitors`
Expected: creates `agent-plugins/agentmonitors/` with `aipm.config.ts` + skeleton manifests, and registers it in the marketplace registries.

- [ ] **Step 2: Set the support envelope**

Edit `agent-plugins/agentmonitors/aipm.config.ts`:

```ts
import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '0.0.1',
  targets: ['claude', 'codex', 'cursor', 'gemini', 'kiro', 'vercel'],
  description:
    'Drop-in monitors: a one-time install that watches .claude/monitors and surfaces changes into your session.',
  keywords: ['agentmonitors', 'monitoring', 'hooks', 'drop-in', 'channel'],
});
```

> Single plugin in the marketplace → Gemini/Kiro are eligible. If a `single-artifact-host` finding ever appears, drop `gemini`/`kiro`.

- [ ] **Step 3: Author the hooks**

Create `agent-plugins/agentmonitors/hooks/claude.yaml`:

```yaml
hooks:
  SessionStart:
    - command: agentmonitors session start
  PreToolUse:
    - command: agentmonitors hook deliver --lifecycle turn-interruptible
  Stop:
    - command: agentmonitors hook deliver --lifecycle turn-idle
  SessionEnd:
    - command: agentmonitors session end
```

> `hook deliver` is the Plan-D command. Until Plan D lands, point `PreToolUse`/`Stop` at `agentmonitors hook claim ...` (which already exists and is harmless) or a no-op, and update to `hook deliver` when D ships. Match the exact hook-manifest shape the toolkit expects (`aipm validate` will tell you if the key/format differs — see `tools/agent-plugins/marketplace-authoring/hooks/` for a concrete example).

- [ ] **Step 4: Author the MCP server (channel upgrade)**

Create `agent-plugins/agentmonitors/.mcp.json` from `channel-plugin/.mcp.json`:

```json
{
  "mcpServers": {
    "agentmonitors": {
      "command": "agentmonitors",
      "args": ["channel", "serve"]
    }
  }
}
```

- [ ] **Step 5: Author the setup skill**

Create `agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md` with frontmatter `name: setup-monitors` and a description that triggers on "set up agent monitors / enable monitoring in this repo." Body: create `.claude/monitors/`, write `.claude/agentmonitors.local.md` with `enabled: true` (via `agentmonitors`... or instruct the agent to run a setup command), add `.claude/*.local.md` to `.gitignore`, and show the smallest monitor file. Keep it short and trigger-precise.

- [ ] **Step 6: Build + validate**

Run: `pnpm exec aipm build`
Run: `pnpm exec aipm validate`
Expected: build generates the registries + any repo-root Gemini/Kiro artifacts; validate passes (schema/envelope/registration/freshness). Fix any findings per the `marketplace-authoring` skill's "Interpreting common findings" table.

- [ ] **Step 7: Commit (sources + generated together)**

```bash
git add agent-plugins .claude-plugin .cursor-plugin .agents gemini-extension.json GEMINI.md POWER.md commands skills steering .kiro 2>/dev/null
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add the agentmonitors activation plugin (hooks + channel MCP + setup skill)"
```

> Only add the repo-root artifact paths that `aipm build` actually generated (it records them in `.aipm/generated-root.json`).

---

## Task 3: Fold in `channel-plugin/`, wire CI and ignores

**Files:** `channel-plugin/` (remove), `.prettierignore`, `.gitignore`, `.github/workflows/*`

- [ ] **Step 1: Retire the standalone channel-plugin**

The channel MCP now ships inside the activation plugin. Remove `channel-plugin/` and update any doc/spec references (006, spec-changelog) to point at `agent-plugins/agentmonitors/.mcp.json`.

```bash
git rm -r channel-plugin
```

- [ ] **Step 2: Keep Prettier off generated marketplace content**

Add to `.prettierignore`:

```
agent-plugins/
.claude-plugin/
.cursor-plugin/
.agents/
gemini-extension.json
POWER.md
```

- [ ] **Step 3: Ensure local-state is gitignored**

Add to `.gitignore` (if not already): `.claude/*.local.md`.

- [ ] **Step 4: Wire `aipm validate` into CI**

In the CI workflow that runs `pnpm check`, add a step `pnpm exec aipm validate` (so registry freshness is enforced on every PR). Confirm it does not collide with the existing Prettier/eslint steps now that the marketplace paths are excluded.

- [ ] **Step 5: Verify the whole repo is still clean**

Run: `pnpm check`
Run: `pnpm exec aipm validate`
Expected: both pass; no Prettier complaints about generated files; freshness clean.

- [ ] **Step 6: Commit**

```bash
git add .prettierignore .gitignore .github docs/specs
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Fold channel-plugin into the activation plugin; wire aipm validate in CI"
```

---

## Task 4: Docs + changeset

**Files:** `docs/specs/006-agent-integration.md`, `docs/specs/spec-changelog.md`, `docs/specs/roadmap.md`, README

- [ ] **Step 1: Update specs + README**

006: document that activation ships as a colocated aipm marketplace plugin (the hooks + channel MCP), multi-host incl. Codex. README: add an "Install" section (`/plugin marketplace add mike-north/AgentMonitors`, `codex plugin marketplace add …`, `npx plugins add …`). spec-changelog entry "2026-06-04 — Activation plugin via aipm marketplace (C)". (CLI/plugin-only; no changeset unless core changed.)

- [ ] **Step 2: Format + clean verification**

Run: `npx --no-install prettier --write "docs/specs/*.md" "README.md"`
Run: `pnpm build && pnpm test && pnpm check` (and `pnpm exec aipm validate`)
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add docs/specs README.md
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Document activation distribution via the aipm marketplace plugin"
```

---

## Final verification

- [ ] `pnpm exec aipm validate` passes; a fresh `pnpm exec aipm build` produces **no** git diff (freshness).
- [ ] Manual: `/plugin marketplace add <local-clone-or-owner/repo>` in Claude Code lists `agentmonitors`; installing it registers the four hooks and the channel MCP (verify via `/hooks` and the MCP server list).
- [ ] `codex plugin marketplace add …` lists it too (multi-host smoke).

## Self-review notes (author)

- **Spec coverage:** design §4.1 distribution → all tasks; the no-restart property holds (hooks are fixed; monitors are data).
- **Sequencing dependency:** the `PreToolUse`/`Stop` hooks call `hook deliver` (Plan D). If C lands before D, wire them to the existing `hook claim` and update in D — Task 2 Step 3 notes this.
- **Naming consistency:** the MCP server key `agentmonitors` matches `channel-plugin/`'s, preserving the `<channel source="agentmonitors">` tag.
