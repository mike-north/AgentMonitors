## 2026-06-19 — Four invariants added to 000: PP9, PP10, AP7, NP5 — Refs #126

Ratified in the 2026-06-19 product call. Four new principles added to
[000 — Principles & Properties](./000-principles.md):

- **PP9 (agents declare and move on):** An agent may declaratively express monitoring intent but
  performs no watching mechanics itself and never polls or blocks waiting for a signal. The daemon
  owns all observation and waiting; signals are pushed to the agent when ready.
- **PP10 (deterministic daemon floor / ships no model):** The daemon performs only deterministic
  work — observe, shape, diff, persist, project, deliver — and ships no model and holds no
  model-provider credentials. Any summarization or interpretation runs via the user's own installed
  AI tool, opt-in and behind an adapter, never in the daemon core.
- **AP7 (one pipeline, two authoring paths):** Ephemeral, agent-declared, session-scoped monitors
  and persistent `MONITOR.md` monitors are the same runtime machinery. Ephemeral monitors are an
  additional authoring and lifecycle path into the one pipeline, not a parallel system.
- **NP5 (local-agent-only delivery, current scope):** Agent Monitors delivers to local agent hosts
  only; cloud-hosted agents are out of scope while the only known integration path is a polling loop
  that contradicts the push model (pairs with NP1). Revisit only if a host exposes a local
  push/hook primitive.

These invariants ground the multi-host, local-agent-facing direction (#126, recast in the
2026-06-19 product call from "defer web/cloud-agent support" to active multi-host local-agent
support) and dependent chains (#124). The §7 cross-reference index is updated: PP9, PP10, and AP7
added to the `002` row; PP9, PP10, AP7, and NP5 added to the `006` row; PP10 added to the `005`
row.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #126.

