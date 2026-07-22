---
'@agentmonitors/cli': minor
'agentmonitors': patch
---

Keep the daemon alive for an idle channel-attached session (issue #435 Option A).

The channel is the push surface for an idle agent, but the daemon's lifetime was a function of hook
activity — and an idle listener fires no hooks. Composed, those two facts guaranteed the daemon was
already reaped by the time a channel event should have fired: the session went dormant, the
active-session count reached zero, the daemon self-terminated after `--reap-after-ms` (default
5 min), monitors stopped ticking, and the channel went permanently silent exactly when it was needed.

- A **non-stale `channel`-transport heartbeat** for a workspace now counts as reaper activity, so a
  channel-attached session keeps its daemon alive and ticking even after it has gone dormant.
- The exemption is the heartbeat's **TTL lease**, re-evaluated on every reap check — not a static
  "a channel is registered" flag. A channel server that dies uncleanly stops counting within its
  (short, 30s) TTL and reaping resumes, so an orphaned channel server can never pin the daemon alive
  forever. It is an active expiring lease, not a permanent pin.
- Only the `channel` transport qualifies. The `hook` transport is self-healing (a fresh process per
  prompt) and carries a 24h "wired-up" TTL that would otherwise keep the daemon alive for a day after
  a session ended, so a hook heartbeat never exempts.
- The pure `shouldReap` decision takes a single `channelAttached` boolean; the daemon loop does the
  registry read and staleness check, so the policy stays deterministically testable. Verified end to
  end against a real daemon with a real short reap window: a live channel keeps a dormant-session
  daemon alive and still firing a monitor past the reap window, a stale lease lets reaping resume,
  and a live hook heartbeat does not exempt.

See docs/specs/002-runtime-delivery.md §10.2 and docs/specs/006-agent-integration.md §12.8.
