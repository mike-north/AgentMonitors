---
title: Agent Monitors — Give your agent ears
description: >-
  Agent Monitors watches the things you care about — files, APIs, repos, docs,
  CLIs — and tells your agent the moment they change. Open-source, local-first,
  works with Claude Code, Codex & Cursor.
---

{% nav /%}

{% hero
   eyebrow="Open-source · local-first · works with Claude Code, Codex & Cursor"
   headline="Give your agent ears."
   subhead="Agent Monitors watches the things you care about — files, APIs, repos, docs, CLIs — and tells your agent the moment they change. No polling loop. No re-asking. Your agent finds out on its own."
   primaryCta="Get started"
   primaryHref="#quickstart"
   secondaryCta="How it works"
   secondaryHref="#how" /%}

{% positioningBeat %}
Your agent can already **see** and **act** — eyes (computer-use), and hands (tools).
**Hearing is the sense it's missing** — and the one nobody else is building.
{% /positioningBeat %}

{% section index="02" kicker="the problem" id="problem" %}

## Today, you're the polling loop.

{% twoCol %}
{% prose %}
Right now, **you** are how your agent finds things out. "Check my email again."
"Any new comments?" "Did CI pass yet?" You keep going back and poking it.
**You're the loop** — running on your own attention.

Or you wired one up yourself: a script that wakes the agent every few minutes
to go look. Now it burns tokens on every tick whether or not anything changed,
re-derives what's different by eyeballing two big blobs, and quietly breaks the
next time a session restarts.
{% /prose %}

{% youAreTheLoop /%}
{% /twoCol %}

{% prepost %}
{% prepostCard kind="before" %}
- A pile of polling loops, each spending tokens every tick
- Re-deriving diffs in-context, eyeballing two big blobs
- All fighting the same rate limits and locks
- Scattered across shell scripts you'll never find again
- Silently broken the moment a session restarts
{% /prepostCard %}

{% prepostCard kind="after" %}
- One simple markdown file per thing you care about
- Heard **only when it matters**, pre-digested
- Reliable across restarts and tool updates
- Private — it all stays on your machine
- Future-proof — declare it once; the plumbing can change underneath
{% /prepostCard %}
{% /prepost %}

{% oneliner %}
Stop being the loop. {% sig %}Let your agent be told.{% /sig %}
{% /oneliner %}

{% /section %}

{% section index="03" kicker="how it works" id="how" %}

## Declare what matters. Your agent hears the rest.

The whole thing is **one small file**. The top says what to watch; the body
says what it means and what to do.

{% monitorUnit /%}

{% steps %}
{% step n="01 · declare" heading="You write the file" %}
A `MONITOR.md` next to your code: what to watch, and what it means. Versioned,
in one place.
{% /step %}

{% step n="02 · it listens" heading="A daemon watches" %}
A lightweight local daemon watches deterministically, off to the side. No
tokens spent while nothing changes.
{% /step %}

{% step n="03 · told" heading="Your agent is told" last=true %}
Only when something actually changes — pre-digested, and delivered at a moment
it can act on it.
{% /step %}
{% /steps %}

{% anatomy /%}

{% /section %}

{% section index="04" kicker="why it holds up" id="why" %}

## Built to survive contact with real work.

{% pillars %}
{% pillar n="01" heading="Monitor everything that matters — not just what you can afford to poll." span="lead" %}
Polling taxes you on every tick, so you ration what you watch. Agent Monitors
charges you only when something happens — so the ceiling lifts. One agent can
stay aware of dozens of things at once.
{% /pillar %}

{% pillar n="02" heading="Your agent gets the answer, not the homework." span="span6" %}
A precise, pre-computed diff — it won't hallucinate or miss a change the way an
agent comparing two big blobs does. Cheaper _and_ more correct.
{% /pillar %}

{% pillar n="03" heading="It doesn't forget while you're away." span="span4" %}
A durable local daemon remembers what each session last saw. Restart your
agent, update your tools — you won't miss what happened in the gap.
{% /pillar %}

{% pillar n="04" heading="Your data stays on your machine." span="span4" %}
The daemon is local; what it watches and remembers lives on your disk, not
someone's cloud. Your internal Slack, your private repos, your docs.
{% /pillar %}

{% pillar n="05" heading="One watch, many agents." span="span8" %}
Twenty agents polling the same API is twenty loops fighting rate limits and
locks. Point them at one monitor instead — one ingress, no contention.

{% fanout /%}
{% /pillar %}

{% pillar n="06" heading="One file beats a graveyard of shell scripts." span="span4" %}
Declarative, versioned, in one place — not monitoring hacks scattered across
script folders you'll never find again.
{% /pillar %}

{% pillar n="07" heading="Write it once; it keeps working." span="span8" %}
A monitor declares _what_ to watch and what to do — never _how_ the signal
reaches your agent. As agent tools gain better ways to receive signals (channels
and beyond), Agent Monitors adopts them and your existing monitors just work.
{% /pillar %}
{% /pillars %}

{% callout question="\"Won't channels make this obsolete?\"" %}
No — the opposite. A channel is _how_ a signal gets in; a monitor is _what
you're listening for._ Most of what matters — a file, a CLI's output, a new blog
post — never pushes itself anywhere; something has to go listen.
{% sig %}Channels are the ear canal. Monitors are the hearing.{% /sig %}
{% /callout %}

{% hostNote %}
Works wherever your agent has hooks — Claude Code, Codex (CLI & desktop), and
Cursor. One shared mechanism, not one vendor.
{% /hostNote %}

{% /section %}

{% section variant="quick" index="05" kicker="quickstart" id="quickstart" %}

{% quickGrid %}
{% prose %}

## Your first five minutes.

1. **Install the CLI** — `npm install -g @agentmonitors/cli`.
2. **Scaffold a monitor** — `agentmonitors init my-first-monitor` writes a
   ready-to-edit `MONITOR.md`. Say what to watch and what it means.
3. **Run the daemon** — `agentmonitors daemon run` watches deterministically,
   off to the side, and delivers through your agent's hooks.
4. **Start your agent** — the next time something changes, it **hears about
   it**. No re-asking.

[Read the docs →](/docs/getting-started)
{% /prose %}

{% quickstartTerminal /%}
{% /quickGrid %}

{% /section %}

{% section variant="section--tight" kicker="doors" id="docs" %}

{% doors %}
{% door heading="Getting started" href="/docs/getting-started" %}
Install, author your first monitor, run it, and see a signal land in your agent.
{% /door %}

{% door heading="Authoring monitors" href="/docs/authoring-monitors" %}
The full `watch:` model, every source, urgency, and notify timing.
{% /door %}

{% door heading="Docs" href="/docs/monitor-standard" %}
The open, host-agnostic Monitor Standard — available as rendered HTML _and_ raw
markdown.
{% /door %}
{% /doors %}

Using an AI coding agent? Point it at [agentmonitors.io/skill.md](/skill.md) — it's a
self-contained, agent-readable setup guide that installs the CLI, authors a monitor, and proves
it fires, with no other context required.

{% /section %}

{% siteFooter /%}
