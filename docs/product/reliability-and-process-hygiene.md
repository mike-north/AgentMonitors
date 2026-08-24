# Reliability & Process Hygiene

> **Status:** Draft — states the **target contract**, not a description of what today's build
> already delivers; known gaps are tracked as issues and measured against this bar (see "The
> promises we make").
> **Purpose:** the reliability posture we commit to as a product — the kinds of reliability
> and _process hygiene_ Agent Monitors offers, and the tangible benefit each choice buys the
> user. This is the _why_ and the _promise_; the technical spec that realizes it is
> [spec 008 — Reliability & Process Hygiene](../specs/008-reliability-process-hygiene.md).
> Companion to [vision & positioning](./vision-and-positioning.md), which
> names durability and reliability as the spine.

## The one-line thesis

**Agent Monitors is a process you leave running.** Its entire value depends on being the kind
of thing you can start once and forget — watching quietly for weeks, never something you have
to babysit, clean up after, or restart because it got weird. Reliability and process hygiene
are therefore not features layered on top; they are the **precondition for the product
existing at all.**

> A monitor that occasionally leaks a runaway process, drains a battery, or has to be
> `killall`-ed is worse than no monitor. It converts a background helper into a background
> liability — and the user only has to be burned once to stop trusting it.

## The problem we own

A long-running local daemon that spawns other processes is a well-known way to lose a user's
trust slowly. The failure is rarely dramatic; it is _erosion_:

- a poll command hangs, and its children keep running after the monitor has moved on;
- the daemon is force-killed (a crash, an OOM, a laptop that went to sleep mid-tick) and
  leaves in-flight work orphaned to the OS;
- those strays accumulate across days — a few CPU-spinning processes, a warm laptop, a fan
  that won't quit — until the user notices, reaches for Activity Monitor, and finds _our
  name_ (or worse, an anonymous `sh` we spawned) at the top of the list.

Once that happens, the verdict is set: **"it leaks, I have to keep an eye on it."** For a tool
whose only job is to run unattended, that verdict is fatal. The reliability posture below
exists to make that verdict impossible to reach — not to make leaks _rare_, but to make the
system **accountable for everything it starts that remains within the containment boundary**
(defined below).

## The promises we make

These are the guarantees the product is built to deliver — the **target contract**, stated in
the same current-vs-target discipline the numbered specs use. Where the implementation is known
to fall short today, the gap is tracked as an issue and this document is the acceptance bar
those issues are measured against (as of this writing:
[#470](https://github.com/mike-north/AgentMonitors/issues/470) — poll-command lifetime bounds
today live only in daemon-resident timers, so a hard-killed daemon can orphan the command and
its descendants; PR #472 proposes a self-bounding watchdog intended to narrow this to a
residual gap for close-on-exec descendants once its correctness blockers are fixed and it
lands;
[#478](https://github.com/mike-north/AgentMonitors/issues/478) — the restart sweep for
orphaned poll-command process trees is open work, with
[#426](https://github.com/mike-north/AgentMonitors/issues/426) tracking the adjacent
daemon/channel-server process hygiene;
[#479](https://github.com/mike-north/AgentMonitors/issues/479) — live cleanup paths do not yet
positively verify a target's identity at signal time, so promise #3 is a target;
[#480](https://github.com/mike-north/AgentMonitors/issues/480) — the capability probe,
automatic strongest-mechanism selection, and achieved-guarantee reporting behind promise #5 do
not exist yet;
[#469](https://github.com/mike-north/AgentMonitors/issues/469) — the always-on daemon has no
coherent power posture yet (wake coalescing, event-driven sources, conditional requests,
battery-aware intervals, sleep reconciliation), so promise #4's gentleness is likewise a
target;
[#507](https://github.com/mike-north/AgentMonitors/issues/507) — the active abstention
warning below — a durable, user-visible warning rather than a diagnostics record, including
when no session is open at abstention time — does not exist yet).
A promise below is not an assertion that today's build already delivers it; it is the
bar a gap must meet before it can close.

**The containment boundary.** Every promise below applies to processes _within our containment
boundary_: anything Agent Monitors spawns that has not both (a) deliberately detached itself
into an independent session **and** (b) erased the marks that identify it as ours. A process
that does both has, by construction, made itself indistinguishable from unrelated work on the
machine — it has left the boundary, and [the limits section](#the-limits-we-are-upfront-about)
describes honestly what that means. Defining the boundary once, here, is what lets each promise
be stated without a hedge.

### 1. Nothing we start outlives its purpose

Every process Agent Monitors spawns — a poll command, and anything that command itself spawns
that stays within the containment boundary — is **accounted for and bounded**. When its work is
done, or its time is up, it is cleaned up. Within the boundary, there is no path where a
monitor tick quietly leaves something running behind it.

> **What the user gets:** you can run dozens of monitors for weeks and never accumulate a
> single stray process. The process list stays as clean as the day you started.

### 2. It survives its own death without leaving a mess

If the daemon crashes or is force-killed, two things still hold: in-flight spawned work is
**still bounded** (its cleanup does not depend on the daemon being alive to perform it), and
any stray left by a previous life that is still within the containment boundary is **swept on
the next start.** Restarting is self-healing, not a manual cleanup chore.

> **What the user gets:** a crash or a hard reboot is a non-event. You start the daemon again
> and it tidies up after its former self — you never have to hunt down leftovers by hand.

### 3. When it cleans up, it only ever kills what is ours

Cleanup is **identity-verified.** Agent Monitors will never signal a process it cannot
positively confirm belongs to it — not even rarely, not even under heavy process churn where
the operating system has recycled an old identifier onto someone else's work.

> **What the user gets:** the tool cannot, even in its worst case, reach over and kill your dev
> server, your editor, another agent session, or an unrelated terminal. A background reaper you
> can trust _not_ to cause collateral damage is the difference between "helpful" and
> "dangerous."

### 4. Our own machinery is gentle on the machine

Agent Monitors' **own machinery** — the daemon, its tick loop, its bookkeeping — watches
**quietly**: no busy-spinning, no runaway load, no surprise battery drain, and idle monitors
cost close to nothing. A monitored command is a different matter: it is the _user's own
program_, and we deliberately do not govern how hard it works (see non-goals). What we promise
about it is **time-boundedness** — it runs only within its allowed window, and what it leaves
behind is cleaned up — not that it will be frugal while it runs.

> **What the user gets:** the monitoring itself is never why the laptop is hot. If a machine
> is working hard, it is because a command _you configured_ is working hard, inside a window
> you set — never because our plumbing is spinning.

### 5. It is honest about the guarantee it can actually deliver

Different environments allow different levels of enforcement. Rather than over-claim, the
system **tells you the level of containment it is actually providing** in your environment —
and because the strongest reachable level is always selected automatically (see below), that
disclosure is a report, never a configuration surface. We never advertise a guarantee we
cannot keep on the machine in front of us.

> **What the user gets:** trustworthy signals about the tool's _own_ health, and no nasty
> surprises where a promised guarantee silently didn't apply. Honesty about limits is itself a
> reliability feature — it is what lets you calibrate how much to lean on it.

## The product choices these promises imply

The promises above are deliberate bets. Two of them are worth calling out because they shape
the whole design, and because the trade-offs are ones we are choosing on purpose.

### We reach for the strongest guarantee your machine allows — automatically

The single most important choice: **there is no reliability tier for the user to pick.** On
every machine, the system probes what enforcement the operating system actually exposes and
automatically uses the strongest one available there — from the OS's own kernel-level
containment where it is reachable, down to a robust, universal fallback where it is not. The
user selects nothing and cannot accidentally end up on the weak path.

What is uniform is not the _result_ but the _policy_: we always maximize. The guarantee we
actually achieve legitimately varies by environment — that is a property of what each OS and
security policy permits, not of who installed what — and (per promise #5) we always tell you
exactly what we achieved on the machine in front of you.

Crucially, the strongest guarantee is often reachable with **no native dependency and no
install step at all**: on a large class of machines the kernel's own containment is driven
through ordinary system interfaces the daemon can already use, so those users get the maximum
out of the box. Where the very strongest primitive on a given platform requires a component the
default package cannot include, we run the strongest available path regardless, and if that
component is present we detect and use it automatically — it is never a gate between a user and
a working install.

> **What the user gets:** you never choose a reliability level, and you can't pick the weak one
> by mistake. The tool always delivers the most your machine can enforce, and tells you what
> that is. Nobody is a second-class user; every machine gets its own ceiling, reached
> automatically.

This is a genuine product stance, not a hedge: uniform _effort_ toward the strongest guarantee,
with honest disclosure of the achieved level, beats a single advertised guarantee that silently
means different things on different machines. We would rather always reach for the maximum and
name what we got than promise one number and quietly degrade.

### We would rather leak once than kill the wrong thing

Where a trade-off is unavoidable, we bias toward **never causing collateral damage**, even at
the cost of a rare failure to clean something up. That leak comes in two distinct classes, and
we are precise about which is which:

- **Abstention** — the tool found a process it _suspects_ is ours but cannot positively
  confirm, so it leaves it alone. An abstention is **visible and warned about**: the tool
  actively warns the user — naming what it declined to reap and stating its confidence
  honestly ("this looks like ours, but we could not confirm it"), never overstating a
  suspicion as a certainty — so the user can decide, rather than leaving the record to sit
  silently in diagnostics.
- **Escape** — a descendant that has fully detached and erased its identity (left the
  containment boundary). By construction we can no longer recognize it, so we can neither
  bound it nor report it; recovery is the user's ordinary OS tooling. We state this plainly in
  the limits below rather than pretend a process we cannot see is somehow accounted for.

A missed cleanup — of either class — is recoverable; killing an unrelated process is silent
damage to the user's other work and exactly the kind of betrayal that ends trust permanently.

> **What the user gets:** the tool's failure modes are always the _safe_ kind. In the rare
> corner where it cannot be certain, it errs toward leaving things alone, not toward force —
> and it tells you about everything it can still see.

## The limits we are upfront about

Honesty is part of the posture, so we name the boundaries plainly rather than bury them:

- **A process that fully detaches and erases its own identity leaves the containment
  boundary — and with it, our sight.** A child that deliberately daemonizes itself into an
  independent session and strips the marks that identify it as ours is, by construction, no
  longer distinguishable from any other process on the machine. Detached processes that keep
  their identity are caught by the restart sweep; the minority that also erase it are outside
  what any local tool can safely reap without risking collateral damage — and, honestly,
  outside what our diagnostics can attribute or bound. Recovery there is the user's ordinary
  OS tooling. We will not close this gap by guessing.
- **The strongest containment is not achievable on every machine.** What each OS and security
  policy exposes differs, so the guarantee we reach varies — we always run the strongest one
  the machine allows and name it, rather than advertise one guarantee that quietly means
  different things in different places.
- **These are reliability guarantees, not a security boundary.** Process hygiene protects the
  user from _our_ mess; it is not a sandbox against hostile code and is not marketed as one.

## What this is not

- **Not a process manager or supervisor for the user's own workloads.** We keep _our own_
  spawned work accountable; we are not `pm2`, systemd, or a general job runner for things the
  user launches themselves.
- **Not a resource governor.** We are gentle by construction and bound what we start, but we do
  not offer CPU/memory quotas or scheduling policy as a product surface.
- **Not a promise of zero orphans through hardware failure.** A yanked power cord leaves the OS
  to reap; our commitment is that the _next start_ reconciles, not that physics is defeated.

## How we will know we got it right

The posture succeeds when these become true and stay true (each scoped, like the promises, to
the containment boundary):

- A user can run the daemon continuously for weeks and find **zero** processes attributable to
  Agent Monitors that it did not intend to be running.
- A hard kill of the daemon, followed by a restart, leaves the process list clean with **no
  manual intervention.**
- There is **no report, ever,** of Agent Monitors signalling a process that was not its own.
- "Is this tool why my machine is warm / slow / loud?" is a question users do not ask.
- When asked what guarantee is in effect, the tool can **answer accurately** for the machine
  it is on.

> The bar is not "leaks are rare." The bar is "the system is accountable for everything that
> remains within the containment boundary — which is precisely where product accountability
> ends — honest about what it can enforce, and safe in every failure mode." That is what earns
> the right to be left running.
