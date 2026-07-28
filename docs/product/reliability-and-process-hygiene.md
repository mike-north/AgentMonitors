# Reliability & Process Hygiene

> **Status:** Draft
> **Purpose:** the reliability posture we commit to as a product — the kinds of reliability
> and _process hygiene_ Agent Monitors offers, and the tangible benefit each choice buys the
> user. This is the _why_ and the _promise_; the technical spec that realizes it is a separate,
> downstream document. Companion to [vision & positioning](./vision-and-positioning.md), which
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
system **accountable for everything it starts.**

## The promises we make

These are the guarantees a user should be able to assume without reading a line of our code.
Each is stated as a promise, followed by the concrete thing the user gets.

### 1. Nothing we start outlives its purpose

Every process Agent Monitors spawns — a poll command, and anything that command itself spawns
— is **accounted for and bounded**. When its work is done, or its time is up, it is cleaned
up. There is no path where a monitor tick quietly leaves something running behind it.

> **What the user gets:** you can run dozens of monitors for weeks and never accumulate a
> single stray process. The process list stays as clean as the day you started.

### 2. It survives its own death without leaving a mess

If the daemon crashes or is force-killed, two things still hold: in-flight spawned work is
**still bounded** (its cleanup does not depend on the daemon being alive to perform it), and
any stray left by a previous life is **swept on the next start.** Restarting is self-healing,
not a manual cleanup chore.

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

### 4. It is gentle on the machine

The system watches **quietly.** No busy-spinning, no runaway load, no surprise battery drain;
resource use is bounded and proportional to the work actually being done. Idle monitors cost
close to nothing.

> **What the user gets:** you don't feel it. Fans stay quiet, battery lasts, and "is Agent
> Monitors why my laptop is hot?" is a question that never comes up.

### 5. It is honest about the guarantee it can actually deliver

Different environments allow different levels of enforcement. Rather than over-claim, the
system **tells you the level of containment it is actually providing** in your environment, and
where a stronger tier is available it offers it as an explicit choice. We never advertise a
guarantee we cannot keep on the machine in front of us.

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
the cost of a rare, bounded, and _visible_ failure to clean something up. A missed cleanup is
an annoyance the user can see and recover from; killing an unrelated process is silent damage
to the user's other work and exactly the kind of betrayal that ends trust permanently.

> **What the user gets:** the tool's failure modes are always the _safe_ kind. In the rare
> corner where it cannot be certain, it errs toward leaving things alone, not toward force.

## The limits we are upfront about

Honesty is part of the posture, so we name the boundaries plainly rather than bury them:

- **A process that fully detaches and erases its own identity can escape live cleanup.** A
  child that deliberately daemonizes itself into an independent session and strips the marks
  that identify it as ours is, by construction, no longer distinguishable from any other
  process on the machine. We catch the overwhelming majority of these on the next restart
  sweep; the vanishing minority that also erase their identity are outside what any
  local tool can safely reap without risking collateral damage. We will not close this gap by
  guessing.
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

The posture succeeds when these become true and stay true:

- A user can run the daemon continuously for weeks and find **zero** processes attributable to
  Agent Monitors that it did not intend to be running.
- A hard kill of the daemon, followed by a restart, leaves the process list clean with **no
  manual intervention.**
- There is **no report, ever,** of Agent Monitors signalling a process that was not its own.
- "Is this tool why my machine is warm / slow / loud?" is a question users do not ask.
- When asked what guarantee is in effect, the tool can **answer accurately** for the machine
  it is on.

> The bar is not "leaks are rare." The bar is "the system is accountable for everything it
> starts, honest about what it can enforce, and safe in every failure mode." That is what earns
> the right to be left running.
