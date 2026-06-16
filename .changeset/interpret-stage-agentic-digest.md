---
'@agentmonitors/core': minor
---

Add the optional **Interpret** stage (roadmap G14): a cheap agentic digest + significance gate via the user's own AI tool

A `payload.form: prose` monitor may now have its **per-recipient delta** read by the user's own
installed AI tool to produce a cheap, natural-language digest and, optionally, an agentic
significance gate that suppresses a not-substantive change (capabilities C10/C11/C38). The stage runs
**after** the per-recipient Diff and before Deliver, and only for `prose` — the deterministic-floor
forms (`structured` / `artifact` / `rendered`) skip it.

The host-specific tool invocation lives behind a new public `InterpretAdapter` interface
(`createClaudeInterpretAdapter` shells out to `claude -p`, argv-only, never a shell) — **never** in
the runtime core (002 §11.1, 006 §2.1). **Agent Monitors ships no model and holds no credentials**
(C45): Interpret is disabled unless an `InterpretAdapter` is injected into `AgentMonitorRuntime`, so
the default behavior is fully backward compatible, and summarization inherits the user's existing
data-governance and egress posture.

The stage is **best-effort**: a tool failure (missing / errors / times out) falls back to delivering
the deterministic `rendered` artifact and is recorded — delivery correctness never depends on a model
call. Every per-recipient verdict (`deliver` / `suppress` / `failed`) is recorded on
`session_event_state` and surfaced by `monitor explain` (§10.7), so "why nothing fired" is
inspectable (C12). New public exports: `InterpretAdapter`, `InterpretInput`, `InterpretResult`,
`ClaudeInterpretAdapterOptions`, `createClaudeInterpretAdapter`, `InterpretDecision`, and an optional
fifth `interpretAdapter` constructor argument on `AgentMonitorRuntime`.
