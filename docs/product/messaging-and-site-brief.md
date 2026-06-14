# Messaging & Website Brief

> **Status:** v1 (living doc) — source of truth for website copy, the design agent (React
> prototype), and the imagery agent.
> **Audience of THIS doc:** us + the design/imagery agents. Not user-facing.
> Companion to [vision-and-positioning.md](./vision-and-positioning.md) (the _why_),
> [use-cases.md](./use-cases.md) (journeys), and [distribution-strategy.md](./distribution-strategy.md) (who/when).

## 0. The job of the site

The current site is accurate but unengaging. Goal: a user-oriented entry point that lands the
value proposition fast, with separate doors for plugin authors and contributors — and contributor-
grade architecture kept _out_ of the user path. Land "what monitoring-for-change looks like
before vs. after Agent Monitors" without drowning the reader in architecture.

## 1. The spine (one idea the whole site hangs on)

**Agents have eyes and hands but no ears.** They can _look_ (screenshot, Chrome, computer-use —
voluntary, foveal perception) and _act_ (tools/MCP). What they lack is the **involuntary, always-on
sense the world uses to reach them** when something changes. **Agent Monitors is that missing
sense.**

Why "ears" is load-bearing (not just cute):

- **It's the interrupt sense.** You can close your eyes; you can't close your ears. A sound makes
  you turn your head — exactly the product: ambient awareness that redirects the agent's attention.
- **It reaches the unseen.** Hearing works through walls and around corners — on things the agent
  isn't and _can't_ be looking at (a Slack channel, an API, a file, a doc on someone else's screen).
  Eyes need line of sight; monitors don't.
- **It's event-shaped.** You notice the doorbell, not the silence — fires on change, doesn't stare.

It unifies every framing we tested: _you are the polling loop_ (today you're the agent's ears — you
keep listening and tapping its shoulder); _apps can push, your agent can't_ (apps make a sound; your
agent is deaf); _notifications for your agent_ (what ears deliver).

**Strategic value of the claim:** eyes (computer-use/Chrome) and hands (tools/MCP) are built by the
agent _platforms_. "Ears" stakes out a sense **nobody else is building**, and it's non-overlapping —
which pre-empts "isn't this just \<computer-use / a tool\>?": no, those are eyes and hands.

### 1.1 Channels-durability (this must survive the channels era)

When Claude Code (and others) gain **channels**, the metaphor _strengthens_, and we say so out loud
to disarm the "won't channels make this redundant?" objection every technical reader will raise:

- **Channel / hook / CLI = the ear canal** — a transport that carries _a_ signal into the harness.
  Content-agnostic; it doesn't know what to listen for, and it can only carry what already pushes.
- **Monitor = the hearing** — two things a canal can never do: (1) reach the **unpushable** (files,
  CLI output, a new blog post, a timestamp field in a JSON doc — none of these push anywhere;
  something must go listen), and (2) **selective attention** — "tell me when _this_ changes and what
  it means," the cocktail-party filter that turns a loud world into one clear signal.

> **Line for the site:** _Channels are the ear canal. Monitors are the hearing._ A channel is _how_
> a signal gets in; a monitor is _what you're listening for_ — and most of what matters never pushes
> itself anywhere. Channels make monitors **better**, not obsolete.

Sub-images (NOT the master metaphor — each reintroduces a human listener, which fights "you're not
the loop"; use only for the specific prop): **stethoscope** → selective tuning; **switchboard** →
fan-out/routing (dated; use sparingly).

## 2. Audience architecture (doors)

| Door                     | Audience                                                                                 | This brief covers         | Notes                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| **Core (Door 1)**        | The **agentic-coding-tool developer** — Claude Code / Codex users (the Wave-2 champions) | **Yes — primary**         | Forks by persona in examples (solo dev vs. chief-of-staff/ops) |
| Plugin author            | Authors embedding monitors in their plugins                                              | Stub now, build later     | "How to ship monitors with your plugin"                        |
| Contributor              | People extending the project                                                             | Stub now, build later     | **Architecture depth lives ONLY here**                         |
| Ambient / personal-agent | Long-lived broad-access agents                                                           | **Deferred → issue #125** | "Ears taken to the limit"; Wave-3 demand-gen                   |

## 3. Hero narrative + the ladder

Same product, audience determines the emotional entry:

- **Door 1 hero (everyone, incl. someone who's only used ChatGPT to search their email):**
  **"You are the polling loop."** You keep coming back — _"check my email again," "any new
  comments?", "did CI pass?"_ — running the loop on your own attention. Requires no prior technical
  pain, only that you've _used_ an assistant. The payoff: **your agent can finally be _told_** — in
  real time, without you re-asking.
- **Door 2 arc (the scarred practitioner who built a polling loop):** the pillars (§4) land as
  **vindication/relief**, not optimization — _"and unlike the loop you'd build, it doesn't melt at
  scale, hallucinate diffs, or die on restart."_

**Candidate category lines:** _Give your agent ears._ · _Stop polling. Get told._ · _Agents have no
notifications. Agent Monitors is notifications for your agent._

**Pre/post (one breath):**

> _Before:_ a pile of polling loops — each spending tokens every tick, each re-deriving diffs
> in-context, all fighting rate limits and locks, scattered across shell scripts, silently broken
> the moment a session restarts.
> _After:_ one declarative file per thing you care about. Your agent hears about it **only when it
> matters**, **pre-digested**, **reliably**, **privately** — and it keeps working as the ecosystem
> evolves.

## 4. Value pillars (supporting; body + Door 2)

Ordered by what to lead with, NOT equal weight:

1. **The scaling wall (hero of the cost story).** Frame as the _ceiling_, not per-call savings:
   polling taxes you every tick whether or not anything changed, so you ration what you watch and
   never build the genuinely-aware agent you want. Agent Monitors flips it — pay only when something
   happens + pre-digested diffs + one centralized watch feeding N agents — so the ceiling lifts.
   (Token efficiency, fan-out, and concurrency are _evidence under this headline_, not separate
   pitches.) **Don't open with "save tokens"** — that reads as optimization.
2. **Quality, not just cost.** A deterministic, pre-digested diff doesn't **hallucinate or miss**
   changes the way an agent eyeballing two big blobs does. Cheaper _and_ more correct; the agent
   isn't drowning in noise it must reason past.
3. **Reliability + catch-up across the gap.** Deterministic daemon, per-session cursors, state on
   disk, decoupled from volatile agent sessions. Survives restarts/updates — and **you never miss
   what happened while you were away** (the session was down; the daemon wasn't).
4. **Local-first / privacy.** The daemon is local; snapshots/diffs/history live on _your_ disk, not
   a third party's cloud. For internal Slack/Docs/PM data (or, later, your body and home network)
   this is a real unlock a SaaS poller can't match.
5. **Fan-out (one watch, many agents).** 20 agents polling = 20 loops, 20× egress, rate-limit and
   SSH/git-lock contention. One centralized watch → one ingress, no contention. (Switchboard image.)
6. **Maintainability.** A declarative `MONITOR.md` (frontmatter + body) vs. shell scripts scattered
   through skill/script folders you can't find. One versioned place.
7. **Forward-compatibility / host-agnostic.** `MONITOR.md` declares _what to watch_ and _what it
   means_ — never the mechanism. New transport (a channel) or new host: adopted by Agent Monitors,
   and **your existing monitors just work.** See §5.
8. **Well-timed, non-disruptive delivery.** Arrives at a turn boundary, not mid-thought; survives
   compaction. "Told when you can act, without derailing the agent."
9. **Reliable _reactions_ (deliver-and-verify)** — for the "what you can build on it" section, not
   the hero: an obligation closes only when re-observation confirms the end-state → idempotent,
   survives interruption.
10. **(Minor) You can see why it fired** — `monitor explain`/history; scattered shell loops are a
    black box when notifications stop.

## 5. Hosts & reach (honest framing)

The no-loop magic depends on a **persistent harness** — the **hooks** that agentic coding tools share,
backed by a local daemon. So:

- **Supported:** the hook-capable agentic coding tools — **Claude Code, Codex (CLI and macOS desktop
  app), and Cursor.** Each is a thin adapter over the same daemon + hook/channel model; the core is
  host-agnostic.
- **Deferred (harness-less hosted web — ChatGPT/Claude on the web):** the only path is an
  agent-waking loop, which contradicts the thesis — **not marketed.** See issue #126.

Site language: lead with the shared **hook mechanism**, not a single vendor — _"Works wherever your
agent has hooks — Claude Code, Codex, and Cursor."_ No "coming soon: web."

## 6. Voice & honesty guardrails

- **"Without you asking," not "instant."** High-urgency settles ~15s; normal/low coalesce. The
  contrast that sells is _push vs. you remembering to re-ask hours later_, not millisecond latency.
  "Instant" invites a nitpick we'd lose.
- **Agent Monitors is the nervous system / the hearing; the agent's tools are the hands.** Never
  imply AM performs the action — it senses change and routes it; the agent acts with its own tools.
  Honest pitch for action stories: "Agent Monitors + a well-equipped agent."
- **Channels are complementary, not competitive** (§1.1).
- **Metaphor is the frame, not a substitute for proof.** Ground "ears" in the concrete payoff in the
  next breath, especially for skeptical engineers, or it reads as fluff.
- **No internal codenames / wave numbers in public copy** (per `git-and-pr` rules). Outcome language
  only.

## 7. Core-site information architecture

1. **Hero** — the ears claim + a category line; the eyes/hands/ears visual (§9 shot 1).
2. **The problem** — "you are the polling loop"; the pre/post (§3).
3. **How it works (value-deep, not architecture-deep)** — the `MONITOR.md` unit: _frontmatter = what
   to watch_, _body = what it means_, annotated (§9 shot 5); the world→ear-canal→hearing→agent
   anatomy (§9 shot 4). Enough to land the value; no internals.
4. **Why it holds up** — the pillars (§4), including the channels-future and host reach (§5).
5. **Quickstart / first five minutes** — `npm install -g @agentmonitors/cli`, drop a `MONITOR.md`,
   see a delivery. (Friction here is the Wave-2 make-or-break.)
6. **Doors** — links to Plugin Author and Contributor.
7. **Footer note:** docs available in **HTML and raw markdown** (`agentmonitors.io` + `*.md`).

## 8. What this brief deliberately excludes

- Deep architecture (→ contributor door).
- The ambient/personal-agent reel (→ #125).
- Web-agent support (→ #126).
- Internal wave/codename language.

## 9. Imagery shot-list (for the imagery/design agent)

1. **The missing sense (hero):** an agent with **eyes** (a screenshot/browser glyph) and **hands**
   (a tool/wrench glyph) lit up, and **ears greyed out** — then the ears switch on as "Agent
   Monitors." One frame states the whole thesis.
2. **You are the loop (before/after):** left — a person wearily re-asking ("any new comments?
   again? again?"), the human _as_ the loop; right — the monitor hears it and the agent already has
   it. Visceral, no jargon.
3. **Fan-out:** "20 agents, 20 tangled polling loops, all hitting one API" → "20 agents, one watch"
   (switchboard/hub). Carries the scaling + contention pillars at a glance.
4. **The anatomy (channels-durability):** world (files/APIs/CLIs/docs) → **ear canal**
   (channel/hook/CLI, labeled "transport") → **hearing** (the monitor: change-detection + "what to
   listen for") → agent. Makes "channels are the canal, monitors are the hearing" self-evident.
5. **The unit:** an annotated `MONITOR.md` — `watch:` block flagged "what to watch (facts the
   runtime handles)", body flagged "what it means + what to do (your judgment, run by the agent)."

## 10. Open / to revisit

- Final category line + name lockup (candidates in §3) — A/B with the design agent.
- Whether the Quickstart shows the channel path once it ships (today: hook/CLI).
- Plugin-author and contributor door copy (separate briefs when scheduled).
