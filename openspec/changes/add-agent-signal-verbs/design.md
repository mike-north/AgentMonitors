## Context

The daemon → agent direction (delivery transports) tells an agent _that_ something changed. This
change adds the complementary agent → daemon read direction. It is deliberately a separate
capability from delivery: delivery marks rows claimed, acknowledgement marks rows acknowledged, and
an agent-facing read changes nothing. Conflating them under "delivery transports" would mis-model
the boundary (source: 007 §1).

| Surface                                  | Direction      | Effect on delivery state                   |
| ---------------------------------------- | -------------- | ------------------------------------------ |
| Delivery transport / `hook claim` / push | daemon → agent | marks rows claimed (not acknowledged, BP2) |
| `events ack`                             | agent → daemon | marks rows acknowledged (SP4)              |
| Agent-facing read (this change)          | agent → daemon | none — pure read                           |
| Ephemeral declare (`watch`)              | agent → daemon | registers a session-scoped monitor only    |

## Goals / Non-Goals

**Goals:** cheap, bounded, read-only follow-ups to a pushed signal that reuse existing durable state
and the existing per-recipient diff seam (AP6).

**Non-Goals:** any new watching, any agent-side waiting, any change to delivery state, any
cloud/internet-visible path (NP5).

## Decisions

- **Reads reuse the per-recipient seam.** A bare `diff` defaults `--from` to the session's
  `session_object_cursor.baseline_content` and uses the runtime's strategy-aware renderer, rather
  than introducing a second diff engine whose output could disagree with delivered diffs.
- **Multi-object `snapshot` lists keys instead of guessing.** Rejected alternative: pick the most
  recently changed object — rejected because a silent guess can hand the agent the wrong file.
- **No long-poll.** Rejected alternative: a blocking "wait for next change" verb — rejected because
  it reintroduces agent-side waiting (PP9); waiting stays daemon-owned and is surfaced by push.

## Open Questions

- **Transport choice (007 §2.3, §8).** Loopback HTTP vs the existing Unix-socket IPC — to be settled
  by dogfooding. Semantics are fixed regardless; loopback HTTP, if chosen, binds loopback-only.
- **Snapshot retention floor (007 §3.2, §8).** How far back historical `monitor_snapshots` rows are
  retained for arbitrary two-point diffs, and the exact error shape when a referenced point has been
  pruned. Silently returning an empty diff is ruled out.
- **Verb/flag names (007 §8).** `snapshot` / `diff` / `summary` are proposed names; final names are a
  PM/implementer call.
- **Bound size (007 §2.1).** The concrete agent-context bound for read output (mirrors the channel
  content-safety bound) is not fixed by the source docs.
- **Formats.** 005 §14 says these verbs support "the standard `--format` shapes"; whether that means
  the `toon`/`json`/`text` auto-detected trio of structured-output commands is left to the
  implementer.
