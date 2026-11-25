## 2026-07-22 — A live channel heartbeat suppresses daemon reaping (002 §10.2, 006 §12.8) — Refs #435 (Option A)

Closes the structural gap #435 named: spec 006 sells the channel as the push surface for an **idle**
agent, but 002 makes daemon lifetime a function of hook activity, and an idle listener fires no
hooks. Composed, those two contracts guarantee the daemon is dead by the time an event should fire —
the session goes dormant, the active-session count reaches zero, the daemon reaps (`--reap-after-ms`,
default 5 min), monitors stop ticking, and the channel is permanently silent.

Option A makes a **non-stale `channel` heartbeat** count as reaper activity, so a channel-attached
session keeps its daemon alive and ticking even while dormant. The exemption is the heartbeat's
owner-declared **TTL lease** (issue #425, `isHeartbeatStale`), re-evaluated against `now` on every
reap check — never a static "a channel is registered" flag — so a channel server that dies uncleanly
stops counting within its (short) TTL and reaping resumes. That is the guard that stops an orphaned
channel server (issue #426) pinning the daemon alive forever: an active expiring lease, not a
permanent pin. Only the `channel` transport qualifies; the `hook` transport's 24h "wired-up" TTL
would keep the daemon alive for a day after a session ended, and its self-healing per-prompt process
needs no persistent daemon between prompts.

- **002 §10.2** states the new reaping contract (channel heartbeat counts as activity; TTL-gated;
  channel-only; the pure `shouldReap` takes a `channelAttached` boolean while the reaper does the
  registry I/O).
- **006 §12.8** states it from the channel-availability side, consuming the lease primitive §12.2
  already anticipated.
- Verified end to end by `daemon-reaper-lease.integration.test.ts` against a real daemon with a real
  short reap window and real heartbeat records: a live channel keeps a dormant-session daemon alive
  and still firing a monitor past the reap window; a stale lease lets reaping resume; a live hook
  heartbeat does not exempt.

This is Option A of the #435 = A + B decision. Option B (a supported persistent-daemon mode,
`daemon run --detach --reap-after-ms 0`) is separate.

