# Agent Monitors — Documentation Site

Next.js + Markdoc documentation site for [agentmonitors.io](https://agentmonitors.io).

## Local development

```bash
# From the monorepo root — install all dependencies once
pnpm install

# Start the dev server (hot-reload)
pnpm --filter @agentmonitors/website dev
# or from inside apps/website/
pnpm dev
```

The site is available at [http://localhost:3000](http://localhost:3000).

## Build

```bash
pnpm --filter @agentmonitors/website build
# or from inside apps/website/
pnpm build
```

Next.js outputs to `.next/`. This is excluded from the monorepo root `pnpm build` / `check`
targets by design — the website is a private app that has its own build cycle.

## Link checking

```bash
pnpm --filter @agentmonitors/website build      # check:links runs against the production build
pnpm --filter @agentmonitors/website run check:links
```

`check:links` starts the built site (`next start`) and crawls it with
[linkinator](https://github.com/JustinBeckwith/linkinator), following every internal link and
validating `#fragment` anchors against the rendered HTML (`--check-fragments`) — no hand-built
approximation of route or anchor resolution. External links are excluded from the hard-failure
path (`--skip`), per this check's scope: internal link/anchor rot only. CI runs this on every PR
that touches `apps/website/**` (see `.github/workflows/ci.yml`, job `website-link-check`).

## Raw-Markdown serving

Every doc page is available as plain `.md` at its URL plus the `.md` extension:

| HTML | Raw Markdown |
|---|---|
| `/` | `/index.md` |
| `/docs/getting-started` | `/docs/getting-started.md` |
| `/docs/authoring-monitors` | `/docs/authoring-monitors.md` |
| `/docs/use-cases` | `/docs/use-cases.md` |
| `/docs/monitor-standard` | `/docs/monitor-standard.md` |
| `/docs/concepts` | `/docs/concepts.md` |
| `/docs/notify-when-a-file-changes` | `/docs/notify-when-a-file-changes.md` |
| `/docs/agent-integration` | `/docs/agent-integration.md` |
| `/docs/troubleshooting` | `/docs/troubleshooting.md` |

The raw endpoint returns `Content-Type: text/markdown` — usable from `curl`, LLM agents,
or any HTTP client that wants the plain source.

**How it works:**
1. `next.config.mjs` rewrites `GET /:path*.md` → `/api/raw/:path*`
2. `src/pages/api/raw/[...path].ts` reads the corresponding `.md` file from `src/pages/`
   and returns it with the correct content-type header.
3. `vercel.json` mirrors the same rewrite rule for Vercel's edge network.

## Pages

| Route | Source file | Description |
|---|---|---|
| `/` | `src/pages/index.md` | Landing page / value prop |
| `/docs/getting-started` | `src/pages/docs/getting-started.md` | Install + first monitor |
| `/docs/authoring-monitors` | `src/pages/docs/authoring-monitors.md` | Full authoring reference |
| `/docs/use-cases` | `src/pages/docs/use-cases.md` | Use cases & journeys |
| `/docs/monitor-standard` | `src/pages/docs/monitor-standard.md` | The open Monitor Standard |
| `/docs/concepts` | `src/pages/docs/concepts.md` | Core concepts overview |
| `/docs/notify-when-a-file-changes` | `src/pages/docs/notify-when-a-file-changes.md` | End-to-end: notified mid-session when a file changes |
| `/docs/agent-integration` | `src/pages/docs/agent-integration.md` | Delivery transports, urgency timing, running without MCP |
| `/docs/troubleshooting` | `src/pages/docs/troubleshooting.md` | Symptom-first fixes for monitors that don't fire or notify |

`public/skill.md` (served at `/skill.md`, linked from the landing page and Getting Started) is a
separate, static, agent-readable setup guide — it has no paired HTML route, so it isn't a "page"
in the table above, but it is part of the site's served surface.

## Deploy

Production deploys are driven entirely by `.github/workflows/deploy-website.yml` — **not**
Vercel's own "deploy every commit" git integration, which is deliberately disabled for this
project so a broken site never reaches production.

- **Trigger:** push to `main` touching `apps/website/**`, the workflow file itself, or a root/shared
  input that can change the resolved site (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, root
  `package.json`) — or a manual `workflow_dispatch`.
- **Validate gate:** the `validate` job must pass, against the exact commit being deployed, before
  the `deploy` job — which `needs: validate` — is allowed to run:
  - `pnpm --filter @agentmonitors/website check` (`tsc --noEmit`)
  - `pnpm --filter @agentmonitors/website test` (the website's own vitest suite, including
    `next.config.test.ts`, which guards deployment-specific tracing behavior)
  - `vercel build --prod --yes --cwd apps/website` — a production build of the exact commit
- **Deploy:** `validate` uploads its `vercel build` output (`.vercel/output`) as a workflow
  artifact; the `deploy` job downloads that exact artifact and runs
  `vercel deploy --prebuilt --prod --yes --cwd apps/website` against the `site` Vercel project
  (`agentmonitors.io`) — promoting the already-typechecked-and-tested build rather than triggering
  a second, independent remote build. The only secret involved is `VERCEL_TOKEN`; the org and
  project IDs are non-sensitive and inlined in the workflow.
- **Concurrency:** deploys are queued (`cancel-in-progress: false`) so two production deploys
  never race.
- **Workflow-shape guard:** `scripts/deploy-website-workflow-shape.test.ts` parses the workflow
  YAML and asserts `deploy` still `needs: validate` and `validate` still runs typecheck, test, and
  a production build — so this gate can't be silently weakened without a failing test.

The domain, DNS, and Vercel project itself are one-time setup already completed for
`agentmonitors.io` — this section only covers how *changes* reach production. To re-run a deploy
without a new commit, use the workflow's `workflow_dispatch` trigger from the Actions tab.
