# Design & Imagery Handoff

> **Status:** v1 — operational companion to [messaging-and-site-brief.md](./messaging-and-site-brief.md)
> (the strategy/source-of-truth). This doc is **copy-pasteable handoff material** for two agents:
> **Part A** → the design agent (React site prototype); **Part B** → the imagery agent (diagrams).
> Draft copy below is real, not placeholder — design around these words, then refine.

---

## Resolved decisions (2026-06-14) — honor these in Part A & B

Settled with the design agent before the build:

- **Scope:** full one-page landing site (all brief sections), at prototype fidelity — not pixel-perfect; we iterate from the whole narrative.
- **Variations:** explore **2–3 _hero_ directions side-by-side** first (the make-or-break, highest-risk visual), pick the winner, then build the full page in that direction. Do **not** fork the whole page into 3 versions.
- **Tweaks panel controls:** theme (light/dark), **hero headline variant**, accent color, display font. _Not_ section density (designer's craft, not a toggle).
- **Hero headline:** ship the variant toggle; **default-show "Give your agent ears."** with "Your agent can look and act. It can't hear. Until now." as the explanatory variant. **"Stop being the polling loop" is the Section-2 headline, NOT a hero option** (hero = promise; §2 = problem).
- **Aesthetic:** technical / terminal — monospace accents, schematic, **engineer-warm**; keep minimal-grade restraint/whitespace so it reads premium, not gimmicky-terminal. Wit lives in copy + diagrams, not loud chrome. (Avoid the forgettable Linear/Vercel refined-minimal default.)
- **Signature accent:** **warm amber / sound-wave gold** — on-metaphor (sound/warmth/the "ears lighting up" glow), engineer-warm on a dark base, and ownable vs. the blue/green/purple dev-tool norm.
- **Diagram split:** **build live (CSS/SVG, theme-aware)** the schematic ones — fan-out (#3), anatomy (#4), annotated `MONITOR.md` (#5); **leave clean labeled placeholders** for the illustration-grade ones the imagery agent will craft — hero eyes/hands/ears (#1) and the before/after "you are the loop" scene (#2).

### Extra guardrails (additive to §"Hard guardrails" below)

- **No fabricated social proof** — no invented "trusted by" logos, user counts, testimonials, or metrics. (This audience spots and punishes it instantly.)
- **Honor `prefers-reduced-motion`** — the ears-lighting-up animation needs a still fallback; keyboard-navigable; legible contrast in both themes.
- **Feel fast and light** — perf signals competence to a dev audience; avoid heavy animation-framework bloat.
- **No marketing clichés** ("supercharge / revolutionize / unleash"); no stock-photo humans (visual language is schematic/illustrated).

## Part A — Design agent prompt (React landing site)

**Paste from here ↓**

You are designing a **landing/marketing site** (React prototype, responsive, light+dark) for
**Agent Monitors** — an open, local-first tool that gives AI coding agents a sense they don't have
yet. The eventual production site is Next.js + Markdoc on Vercel, but produce a clean React
prototype we can integrate. Audience: **developers who use agentic coding tools** (Claude Code,
Codex) — technical, skeptical of marketing fluff, but they respond to a sharp idea and a little wit.
Tone: confident, plain-spoken, a touch playful; credible to engineers (every claim grounded in the
next breath). Do **not** sound like generic SaaS.

### The one idea everything hangs on

**Agents have eyes and hands, but no ears.** They can _look_ (screenshots, browser, computer-use)
and _act_ (tools), but they have no **involuntary, always-on sense for the world changing around
them**. Agent Monitors is that missing sense. Lead with this; make it the visual and verbal anchor.

### Hero section

- **Eyebrow:** Open-source · local-first · works with Claude Code
- **Headline (pick/iterate; A/B these):** "Give your agent ears." / "Your agent can look and act.
  It can't hear. Until now."
- **Subhead:** "Agent Monitors watches the things you care about — files, APIs, repos, docs, CLIs —
  and tells your agent the moment they change. No polling loop. No re-asking. Your agent finds out
  on its own."
- **Primary CTA:** `Get started` (→ quickstart). **Secondary:** `How it works`.
- **Hero visual:** the eyes/hands/ears diagram (Imagery shot 1) — ears lighting up.

### Section 2 — "You are the polling loop"

The emotional hook. Copy beats:

- "Right now, _you_ are how your agent finds things out. 'Check my email again.' 'Any new comments?'
  'Did CI pass yet?' You keep going back and poking it. **You're the loop** — running on your own
  attention."
- "Or you wired up a polling loop yourself: a script that wakes the agent every few minutes to go
  look. Now it burns tokens on every tick whether or not anything changed, re-derives what's
  different by eyeballing two big blobs, and quietly breaks the next time a session restarts."
- **Before/after visual** (Imagery shot 2). Then the one-liner: _"Stop being the loop. Let your
  agent be told."_

### Section 3 — How it works (land the value, NOT the architecture)

- The unit: **one small file.** Show an annotated `MONITOR.md` (Imagery shot 5):

  ```markdown
  ---
  name: Watch the upstream API spec
  watch:
    type: url
    url: https://api.vendor.com/openapi.json
  ---

  The upstream API spec changed. Diff it against my client in src/api/
  and flag any breaking changes I need to handle.
  ```

  Annotate: the `watch:` block = **what to watch** (facts the runtime handles for you); the body =
  **what it means and what to do** (your judgment, run by the agent).

- Three steps, visually: **Declare** (write the file) → **It listens** (a lightweight local daemon
  watches, deterministically, off to the side) → **Your agent is told** (only when something
  actually changes, pre-digested, at a moment it can act).
- The flow visual (Imagery shot 4): world → ear canal (the transport) → the monitor (the hearing) →
  agent.

### Section 4 — Why it holds up (the pillars; cards or a scannable list)

Lead with the ceiling, not the savings:

1. **Monitor everything that matters — not just what you can afford to poll.** Polling taxes you on
   every tick, so you ration what you watch. Agent Monitors charges you only when something happens,
   so the ceiling lifts: one agent can stay aware of dozens of things at once.
2. **Your agent gets the answer, not the homework.** A precise, pre-computed diff — it won't
   hallucinate or miss a change the way an agent comparing two big blobs does.
3. **It doesn't forget while you're away.** A durable local daemon with per-session memory of what
   each session last saw. Restart your agent, update your tools — you won't miss what happened in
   the gap, and you won't have to rebuild your loops.
4. **Your data stays on your machine.** The daemon is local; what it watches and remembers lives on
   your disk, not someone's cloud. (Your internal Slack, your private repos, your docs.)
5. **One watch, many agents.** Twenty agents polling the same API is twenty loops fighting rate
   limits and locks. Point them at one monitor instead. (Imagery shot 3.)
6. **One file beats a graveyard of shell scripts.** Declarative, versioned, in one place — not
   monitoring hacks scattered across script folders you'll never find again.
7. **Write it once; it keeps working.** A monitor declares _what_ to watch, never _how_. As agent
   tools gain better ways to receive signals (channels and beyond), Agent Monitors adopts them and
   your existing monitors just work.

Optional callout box, "Won't channels make this obsolete?": _"No — the opposite. A channel is how a
signal gets in; a monitor is what you're listening for. Most of what matters (a file, a CLI's
output, a new blog post) never pushes itself anywhere — something has to go listen. Channels are the
ear canal. Monitors are the hearing."_

### Section 5 — Quickstart (first five minutes)

```bash
npm install -g @agentmonitors/cli
```

Then: install the plugin, drop a `MONITOR.md`, and the next time something changes your agent hears
about it. Keep this section short and confidence-building; link to full docs.

### Footer / nav

- Doors: **For plugin authors** · **Contributor guide** (architecture lives here, not on the main
  path) · **Docs** (note: available as rendered HTML _and_ raw markdown).
- Open-source, local-first, `agentmonitors.io`.

### Hard guardrails (do not violate)

- Say **"the moment it changes / without you asking,"** never **"instant"** or "real-time
  millisecond" — delivery is well-timed, not zero-latency.
- Agent Monitors **senses and routes**; it does **not** perform actions — the agent acts with its
  own tools. Never imply Agent Monitors "does" things to external systems.
- No internal codenames, wave numbers, or roadmap dates anywhere in copy.
- Every metaphor line is followed immediately by a concrete, literal explanation.

**↑ Paste to here.**

---

## Part B — Imagery agent brief (5 diagrams)

Shared visual language: clean, modern, technical-but-warm; flat/line illustration or crisp
schematic; legible in **both light and dark**; minimal text in-image (labels only). Consistent
palette and iconography across all five so they read as a set.

1. **The missing sense (hero).** An agent (abstract figure or device) with **eyes** (a
   screenshot/viewport glyph) and **hands** (a tool/wrench glyph) clearly lit/active, and **ears**
   greyed-out — then a state where the ears switch on, labeled "Agent Monitors." Must communicate
   "two senses present, one missing, now added" in a single glance. This is the hero; make it
   striking.
2. **You are the loop (before → after).** Left: a tired person manually re-asking an agent in a
   repetitive cycle ("any updates? …again? …again?") — the human visibly _is_ the loop. Right: the
   person at ease while a small monitor element catches a change and hands it to the agent, which is
   already acting. Emotional, not technical.
3. **Fan-out.** Left: ~20 agent icons each with its own arrow polling one API — a tangle, with
   stress cues (rate-limit/lock warning marks). Right: the same 20 agents drawing from a single
   monitor/hub with one clean arrow to the source. Conveys "many loops → one watch."
4. **The anatomy (channels-durable).** A left-to-right flow: **the world** (icons: file, API, repo,
   doc, CLI) → **ear canal** (a labeled "transport: channel / hook / CLI" segment) → **the monitor**
   (labeled "the hearing: detects change + knows what to listen for") → **the agent**. Makes
   "channels = ear canal, monitors = hearing" self-evident.
5. **The unit.** A clean, annotated `MONITOR.md` card: the `watch:` frontmatter block tagged **"what
   to watch — handled for you"**, and the markdown body tagged **"what it means + what to do — your
   judgment, run by the agent."** Editorial/diagrammatic, not a raw code screenshot.

Deliver each as a standalone asset (transparent or theme-aware background) sized for web hero/section
use; provide light and dark variants where contrast matters (shots 1 and 4 especially).

---

## Part C — Terminal style guide (one palette, shared by the site's terminal mockups AND the real CLI)

The site uses a technical/terminal aesthetic and will render fake-terminal blocks; the real
`agentmonitors` CLI is also the first-five-minutes surface. Define **one** terminal styling spec so
both match — a warm-amber "a monitor fired" line in the user's terminal should echo the site's "ears
lighting up." Deliver a **one-page spec** (palette + conventions + a sample of real output styled),
not a CLI redesign. The design agent _proposes_ this; eng implements it later in `apps/cli`.

**Produce:**

- The signature **amber/gold accent as a terminal-safe color**, with fallbacks down the tiers
  (truecolor → 256 → 16). Plus semantic colors: success, warning, error, and a dim/secondary.
- The **signal-moment styling** — how "a monitor fired / here's what changed" reads in the terminal
  (the CLI echo of "ears lighting up"); used sparingly, this is where the accent earns its keep.
- **Glyph/typographic conventions** consistent with the site's schematic feel. Reuse the existing
  `monitor explain` glyphs — `✓` ok, `○` healthy/idle, `✗` failure — and tint, don't replace.
- A worked **sample**: a styled `monitor explain` verdict and a `daemon` tick line, shown in both a
  light- and dark-background terminal.

**Terminal constraints — these are correctness rules, not taste; violating them breaks the CLI:**

- **Honor `NO_COLOR`** (any value present ⇒ no color) and emit **zero ANSI codes when stdout is not a
  TTY** (piped/redirected).
- **`--format json` output is never colored**, TTY or not — it is machine-parsed.
- **Degrade gracefully** truecolor → 256 → 16 → none; pick sane ANSI fallbacks for amber.
- **Legible on light _and_ dark** terminal backgrounds (a pale gold dies on white — choose a
  mid/deep amber).
- **Never rely on color alone** — glyph + label carry the meaning; color only reinforces (colorblind
  and `NO_COLOR` users lose nothing).
- **Restraint** — most output stays default foreground; accent is for the signal moment + key
  glyphs, not everywhere.
