# Vision & Positioning

> **Status:** Draft
> **Purpose:** the _why_ behind the [Monitor Standard](../standard/monitor-md-standard.md)
> and this codebase — the product thesis, where it sits in the landscape, and the bet.
> The standard doc says _what_ a monitor is; this says _why it matters_ and _what we
> optimize for_.

## The one-line thesis

**A coding agent is blind to everything happening outside its own session while it
works.** Agent Monitors is its peripheral vision: it watches the world and hands the agent
a well-timed, actionable signal at the moment it can act — durably, declaratively, and
across hosts.

## The problem we own

An agent already sees the edits it makes. The valuable, hard-to-get signals are the ones
it _cannot_ see from inside a session:

- an upstream API or document changed while you were heads-down,
- a new item landed in a collection you care about (a release, a review comment, a
  vulnerability touching your dependencies),
- a long-running job finished, or a teammate's change made your assumptions stale.

Today, wiring any of these into an agent forces the user to hand-build the entire chain:
write a polling loop, maintain a snapshot of the "before" state, diff it, assemble an
information-dense message, time its delivery, and make it actionable. **A monitor deletes
that chain.** You declare the intent; the runtime handles the loop, the before-state, the
diff, the message, the timing, and the framing.

> You write the intent. We handle the loop, the before-state, the diff, the message, the
> timing, and the framing. You never touch a snapshot again.

## Where we sit in the landscape

Host-native primitives for reacting to change are real and good, and we build _with_ them,
not against them:

- **Scheduling primitives** (run a prompt on a cadence) cover _when to act on a clock_.
- **Push conduits** (deliver an external event into a session) cover _how a signal
  arrives_.

Neither solves the middle: turning _"I want to know whenever X changes in a way that
matters to me"_ into a durable, deduplicated, actionable signal — without the user owning
the polling, the state, and the message design. That middle is the **monitor**, and it is
the part the conduits and schedulers leave to you.

So our positioning is deliberate:

1. **We focus on the blind spot, not task babysitting.** Watching your own build, branch,
   or PR is increasingly well-served by host-native tooling. Our differentiated ground is
   the _external world the agent cannot see_, surfaced through a durable, declarative,
   cross-host mechanism — not any single vertical.
2. **An open standard, plus the best implementation of it.** The normalization layer — the
   `MONITOR.md` format, the change vocabulary, the signal contract — is an open commons
   meant to be adopted by anyone. The value concentrates in _delivery decisioning_ (timing,
   deduplication, batching, cross-event synthesis, relevance) which sits above the
   conformance line. We win on being the best runtime, not on lock-in.
3. **Durability and reliability are the spine.** Signals survive sleep, restart, and
   session rewind. Reliable reactions are _deliver-and-verify_: an obligation closes only
   when re-observation confirms the intended end-state, which makes them idempotent and
   survivable. This is the foundation for building trustworthy automated reactions on top.

## What this is not

- **Not a workflow-automation hub.** We turn change into a well-formed signal for an agent;
  we do not orchestrate arbitrary multi-app automations.
- **Not a distributed event service.** No cross-machine consensus or centralized fan-out is
  part of the contract. Being deliberately local is what lets us avoid distributed-ordering
  problems and keep signals self-contained.
- **Not a replacement for host-native scheduling or push.** We complement them: they are
  the clock and the conduit; we are what decides _what is worth surfacing, and when_.

## Who we build for first

The **solo developer**, optimizing for _time-to-first-useful-signal_. Authoring is
intent-first by design (`watch:` names a thing, never a mechanism) so a useful monitor is a
few lines written in minutes, with no internal machinery to learn. The beachhead sources
are the external blind-spot ones above, where host-native primitives do not reach.

Breadth of sources is a cost we absorb to drive adoption; it is not the value. The value —
and the moat — is the delivery decisioning that turns raw change into a signal an agent can
act on.

## The bet, and the riskiest assumption

The bet: **the durable, declarative, cross-host monitor becomes the standard way agents
gain awareness of the outside world**, the way a portable, simple unit can rally an
ecosystem.

The riskiest assumption is _not_ "can we define the format." It is **adoption and
bootstrap**: the first cohort of authors, and a _second host_ implementing the standard so
portability is proven rather than claimed. A perfect standard with one host is a product
with good docs, not a standard.

Two things de-risk this:

- **The free local runtime is the reference implementation** — the thing that makes the
  standard _runnable_ the day someone writes their first `MONITOR.md`, before any second
  host ships support. It is enterprise-friendly precisely because it is an ordinary local
  developer-tool process with a no-managed-tool delivery path.
- **The standard is useful with dumb delivery.** Anyone can take the format and a trivial
  "fire the hook on every change" runtime and get value with none of our intelligence. Our
  decisioning is a superset enhancement, never a requirement. That bright line is what
  makes the commons safe to adopt.

## Near-term focus

1. Make _time-to-first-signal_ trivial — intent-first authoring, one-command run.
2. Prove portability with one non-Claude host (Codex first).
3. Invest depth in delivery decisioning (the moat), keep source breadth lean.
4. Resolve the open standard questions, especially a re-observable post-condition language
   for reliable reactions.
