## 2026-06-15 — Interpret stage shipped: cheap agentic digest + significance gate via the user's own AI tool (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #178

Implements roadmap **G14**, moving the optional Interpret stage from _target_ to _current_. This
completes the G11–G15 post-processing-pipeline wave.

- **002 §1.1.8 — Interpret (current).** The runtime runs an optional Interpret stage **after** the
  per-recipient Diff/projection, on the per-recipient delta, **only** for `payload.form: prose`
  (built on G15's `PayloadForm`/`payloadSchema`). A non-`prose` monitor never invokes the adapter.
  The stage produces a cheap, natural-language digest sized to the span and may apply an agentic
  significance gate that suppresses a not-substantive delta. It is **best-effort and never on the
  critical path**: an adapter failure (tool missing / errors / times out) falls back to the
  deterministic §1.1.5 `rendered` artifact (the already-projected delivery) and records the failure —
  delivery correctness never depends on a model call succeeding (PP4, AP3).

- **Host-agnostic adapter boundary (002 §11.1, 006 §2.1 — current).** The AI-tool invocation lives
  behind a new `InterpretAdapter` interface in `libs/core/src/adapter/interpret.ts`; the concrete
  `claude -p` (argv-only, never a shell) invocation is `createClaudeInterpretAdapter`. The runtime
  core (`libs/core/src/runtime/`) owns _when_ Interpret runs (after Diff, before Deliver), _whether_
  it runs (the `prose` gate), and the recording of its decision — never the tool's command string. A
  new host wiring a different AI CLI is a new adapter, not a core change.

- **Ships no model, holds no credentials (C45 — current).** Interpret is disabled unless an
  `InterpretAdapter` is explicitly injected into `AgentMonitorRuntime`; the runtime reads no model
  credential. Summarization runs through the user's own installed tool, inheriting their existing
  data-governance and egress posture by construction.

- **Every decision recorded and explainable (C12 — current).** The per-recipient Interpret verdict
  (`deliver` / `suppress` / `failed`) plus its reason/digest is recorded on `session_event_state`
  (right of the seam) and surfaced by the projection-and-delivery stage of `monitor explain` (§10.7),
  so "why nothing fired" is inspectable — an agentic suppression is a deliberate, recorded outcome,
  never a silent drop. A suppressed projection is retained for explainability but excluded from
  delivery (`unreadEventsForSession` / `pendingEventsForSession`).

Verified: `libs/core/src/adapter/interpret.ts` (`InterpretAdapter`, `createClaudeInterpretAdapter`);
`libs/core/src/runtime/service.ts` (`processObservation` post-Diff Interpret + `runInterpret`
best-effort fallback); `libs/core/src/runtime/store.ts` (`recordInterpretDecision`,
`notInterpretSuppressed` delivery exclusion); `libs/core/src/inbox/schema.ts` +
`libs/core/src/inbox/db.ts` (`session_event_state.interpret_*` columns + additive migration);
`libs/core/src/runtime/interpret-stage.test.ts` (proof criteria a–e);
`libs/core/src/adapter/interpret.test.ts` (concrete adapter argv/parse contract).

