## 2026-07-15 — Ephemeral (agent-declared, session-scoped) monitors implemented (007 §4 target → current; 002 §6.2 added) — Refs #312, #259

The ephemeral-monitor model of 007 §4 (landed as _target_ via #282, the foundational primitive of
Epic #259) is now implemented. Agents declare session-scoped monitors that flow the **same** pipeline
as persistent `MONITOR.md` monitors (AP7). All entries below are _current_.

- **007 §4 — target → current.** A new `agentmonitors watch <source> --session <id> --scope <spec>
[--urgency] [--instruction] [--display-name]` declares an ephemeral monitor; `watch list` /
  `watch cancel <id>` (both session-scoped) manage them. The declaration binds to a resolved AgentMon
  session, is persisted in a durable `ephemeral_monitors` table, and returns — the daemon does all
  observation/scheduling/notify/persist/project/deliver (PP9/PP10). The CLI is thin over the daemon
  IPC (`watch.declare|list|cancel`, Zod at the boundary; AP6).
- **007 §4.2 — current, scope parity.** An ephemeral declaration is validated by the **same** core
  `validateScope` path as `agentmonitors validate`, so it cannot express a config a persistent
  monitor could not; an invalid scope is rejected with the identical diagnosis (proven in both paths).
  An **unbindable** declaration (unknown or non-active session) is **rejected**, never silently made
  global.
- **007 §4.3 — decision resolved (ephemeral-id scheme).** Reserved prefix
  `ephemeral:<sessionId>/<ulid>`. Collision with a persistent id is **impossible by construction**: a
  directory-derived persistent id (SP1) is a single path segment and can never contain a `/`, while
  every ephemeral id does. The prefix keeps `monitor_events.monitor_id` / `monitor explain` /
  `queryScope` unambiguous; the id is assigned once and never mutated (stable, SP5).
- **007 §4.4 — current, lifecycle + retention decision.** Active on declaration and evaluated on the
  normal tick. Reaped on explicit session close, on `watch cancel`, and on **per-session dormancy**
  (below). Reaping flips the record `active → reaped` (stamping `reaped_at`) and stops observation but
  **retains** its already-materialized events and projections (the declaring session goes dormant, not
  deleted) — so a late delivery is never dropped (PP1) and a reaped record is **never resurrected** on
  a later restart. While the session lives, the definition + durable state **survive a daemon
  restart** and re-hydrate on the next tick.
- **002 §6.2 — new rule (per-session dormancy trigger).** 002 previously specified only an explicit
  session close (§6.1). §6.2 adds an **inactivity** trigger: an `active` session whose `lastActiveAt`
  has not advanced for at least `DEFAULT_SESSION_DORMANCY_MS` (default 30 min) is transitioned to
  `dormant` at the start of the next tick (and its ephemeral monitors reaped) — a backstop for a
  session that vanished without an explicit close. This is a **per-session** transition, distinct from
  the daemon-wide idle self-termination of 002 §10.2. Overridable in-process for tests.
- **007 §4.6 — current, projection isolation.** An ephemeral monitor's events project into the
  **declaring session only**, never a sibling lead session in the same workspace — the runtime threads
  the declaring session id through materialization to a `restrictToSessionId` projection gate in
  `insertEvent`. This deliberately differs from persistent monitors' all-lead-session projection. Same
  pipeline stages and delivery transports (hook-state, `hook claim`) otherwise.
- **005 §14.4 — target → current.** The `watch` command section is now current; its earlier signature
  listed a `--until <cond>` fire-condition flag, which is deferred to the dependent-chain work (#124)
  and dropped from the current signature (the flag remains _target_).
- **007 §8 — decisions resolved.** The ephemeral-id scheme, per-session dormancy trigger, and event
  retention on reap are all resolved (above); `--until`/fire-conditions and the `snapshot`/`diff`/
  `summary`/`inspect` verbs remain _target_.
- **Verified by** `libs/core/src/runtime/ephemeral-monitors.test.ts` (declaration validity + scope
  parity, namespaced/unique/stable identity with impossible persistent collision, lifecycle —
  active-on-declare, reap-on-close, `watch cancel` immediate reap, restart survival while active, no
  resurrection after session end, dormancy reap and the non-reap of a live session — and projection
  isolation) and the real-daemon-IPC + real-CLI-contract
  `describe('ephemeral monitors: watch declare/list/cancel (007 §4 / 005 §14.4)')` suite in
  `apps/cli/src/commands/cli.integration.test.ts` (declare → tick → declaring-session-only event →
  hook-state + `hook claim` delivery → cancel; plus invalid-scope parity with `validate`).
- **Roadmap:** G17 retired to a shipped blockquote.

