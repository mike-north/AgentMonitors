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

## Raw-Markdown serving

Every doc page is available as plain `.md` at its URL plus the `.md` extension:

| HTML | Raw Markdown |
|---|---|
| `/docs/getting-started` | `/docs/getting-started.md` |
| `/docs/authoring-monitors` | `/docs/authoring-monitors.md` |
| `/docs/use-cases` | `/docs/use-cases.md` |
| `/docs/monitor-standard` | `/docs/monitor-standard.md` |
| `/` | `/index.md` |

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

## Deploy to Vercel (manual steps for the owner)

### 1. Import the project

1. Go to [vercel.com/new](https://vercel.com/new) and click **Add New… → Project**
2. Import the `mike-north/AgentMonitors` GitHub repository
3. Vercel will detect Next.js automatically

### 2. Configure the root directory

The monorepo root is `AgentMonitors/`. The website lives in `apps/website/`. In Vercel's
project settings:

- **Framework Preset:** Next.js (auto-detected)
- **Root Directory:** `apps/website`
- **Build Command:** `pnpm build` (or leave as Next.js default — Vercel runs `next build`)
- **Output Directory:** `.next` (default)
- **Install Command:** `pnpm install` (or leave blank — Vercel detects pnpm)

### 3. Set the domain to agentmonitors.io

1. In your Vercel project → **Settings → Domains**
2. Add `agentmonitors.io` and `www.agentmonitors.io`
3. Vercel will show you the DNS records to add

### 4. DNS configuration at your registrar

Add these records at your domain registrar (exact values shown in Vercel after step 3):

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `76.76.21.21` (Vercel's IP — confirm in dashboard) |
| `CNAME` | `www` | `cname.vercel-dns.com` |

Propagation typically takes a few minutes but can take up to 48 hours.

### 5. Verify

Once DNS propagates:
- `https://agentmonitors.io/docs/getting-started` renders HTML
- `https://agentmonitors.io/docs/getting-started.md` returns raw Markdown

The `vercel.json` at the root of `apps/website/` handles the `.md` rewrite on Vercel's edge
automatically — no additional configuration needed.
