# Glossary

> **Status:** Supporting (non-normative)
> **Covers:** one canonical definition per core Agent Monitors term

This glossary fixes the vocabulary used across the spec set. Each term links to the
numbered doc that governs it. Where a term has a precise normative meaning, the linked doc
is authoritative; this page is a quick index, not the contract.

## Authoring

- **Monitor** — A folder-scoped unit of observation policy, authored as a `MONITOR.md` file:
  YAML frontmatter declares policy, the Markdown body declares handling instructions.
  Governed by [001](./001-monitor-definition.md). (PP2)
- **Monitor ID** — A monitor's stable machine identifier, **derived from the parent
  directory name** of its `MONITOR.md` (never declared in frontmatter). Must be unique
  within a scanned tree. [001 §2, §4](./001-monitor-definition.md). (SP1, SP2)
- **Monitors root** — The single directory a scan/tick/validate operates over. No implicit
  multi-root merge is defined. [001 §6](./001-monitor-definition.md). (AP5)
- **Scope** — The source-specific configuration object in a monitor's frontmatter. Its valid
  shape is defined by the selected source's `scopeSchema`. [001 §3](./001-monitor-definition.md).
- **Urgency** — One of `low`, `normal`, `high`. All three are first-class and affect default
  notify timing and delivery lifecycle. [001 §3.2](./001-monitor-definition.md),
  [002 §4.1, §9](./002-runtime-delivery.md). (PP5)
- **Notify policy** — A monitor's optional `debounce` (`settle-for`) or `throttle`
  (`suppress-for`) configuration. Omitted ⇒ urgency-based defaults.
  [001 §3.4](./001-monitor-definition.md), [002 §4](./002-runtime-delivery.md).
- **Payload form (target)** — The author-declared shape of what a monitor delivers:
  `prose | structured | artifact | rendered`. `prose` invokes the optional Interpret stage; the
  others are deterministic-floor forms. `structured` is produced by a turnkey declarative **jq/CEL**
  transform over the canonical JSON form of the shaped snapshot.
  [001 §5.2](./001-monitor-definition.md#52-payload-form-target),
  [002 §1.1.6](./002-runtime-delivery.md#116-author-declared-payload-form). (capability C46)

## Sources & observation

- **Source (plugin)** — The component that reads external state and detects change. Provides
  `name`, `scopeSchema`, `observe()`; may provide `stateful`, `watch()`. The runtime owns
  _when_ it runs; the source owns _how_ it observes. [003 §2](./003-source-plugins.md). (PP3)
- **Source registry** — The lookup of registered sources by name; the shared surface for CLI
  listing, schema generation, and validation. [003 §6](./003-source-plugins.md). (AP4)
- **Observation** — A single change-detection result returned by a source's `observe()`
  (`title`, `body`, `summary`, `payload`, `snapshotText`, `objectKey`, `queryScope`,
  `snapshot`). Not yet durable. [003 §2.3](./003-source-plugins.md).
- **Baseline** — The first persisted state a stateful source records before it can detect a
  later change. A baseline run legitimately returns **no** observations.
  [003 §2.4](./003-source-plugins.md). (PP6)
- **Source state** — Change-detection state owned by the source and returned via `nextState`
  (e.g. file fingerprints, last API body). [002 §3](./002-runtime-delivery.md).
- **Object key (`objectKey`)** — The source-defined identity of the _thing_ being observed
  (a file path, a URL, a cron string). Distinct from the event's own ID.
  [003](./003-source-plugins.md). (SP3)
- **Query scope (`queryScope`)** — Structured, queryable facets of an observation used to
  filter events (e.g. `filePath`, `url`, `cron`). Filtering targets this, not raw payload
  internals. [002 §14](./002-runtime-delivery.md).

## Runtime & delivery

- **Post-processing pipeline (target)** — The conceptual stage order an observation flows through:
  `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]`. Names and
  fixes the order and the one structural seam. [002 §1.1](./002-runtime-delivery.md).
- **Shared / per-recipient seam (target)** — The boundary between Pace and Diff. Everything left of
  it (Observe…Pace) is computed **once** and shared across all recipients; everything right of it
  (Diff…Deliver) is **per recipient**, against that recipient's baseline/cursor. The structural
  reason fan-out is cheap (capability C15). [002 §1.1.2](./002-runtime-delivery.md#112-the-shared--per-recipient-seam).
- **Composite observation (target)** — One `Observation` assembled from **many** source queries/calls
  into a single whole-state snapshot, on the shared side of the seam (the `[Compose]` stage). Carries
  one `objectKey` for the assembled whole. [003 §2.6](./003-source-plugins.md). (capability C40)
- **Derived fact (target)** — A relative/aggregate fact (e.g. "past due", "stalled", "revealed",
  "urgent") computed by the **Shape** stage as a **pure function of `(shaped snapshot, injected now)`**
  — deterministic, shared, no model. Sources surface the **raw facts** it consumes and do not
  pre-compute it. [002 §1.1.4](./002-runtime-delivery.md#114-shape-deterministic-derived-facts),
  [003 §2.7](./003-source-plugins.md). (capability C41)
- **Rendered artifact (target)** — The stable, token-efficient, markdown-ish (not JSON) text the
  **Shape** stage renders the shaped state into; the runtime diffs **this artifact**, not the raw
  source, so deltas are semantic and cheap. Deterministic render is a prerequisite for a useful diff.
  [002 §1.1.5](./002-runtime-delivery.md#115-shape-render-to-a-stable-artifact-then-diff-the-artifact).
  (capabilities C42/C43)
- **Runtime** — The poll-and-project engine: scans monitors, evaluates due sources, persists
  source/notify state, materializes events, refreshes hook state.
  [002 §2](./002-runtime-delivery.md). (AP3)
- **Tick** — One iteration of the runtime loop. [002 §2](./002-runtime-delivery.md).
- **Daemon** — The long-running process (`daemon run`) that ticks on an interval and serves a
  Unix-socket IPC API. `daemon once` runs a single tick **in-process, without the socket**.
  [002 §10 / §"Daemon and IPC"](./002-runtime-delivery.md), [005](./005-cli-reference.md).
- **Notify dispatch** — The runtime step that turns raw observations into _emitted_
  observations using debounce/throttle/immediate semantics. [002 §4](./002-runtime-delivery.md).
- **Notify state** — Delivery-timing state owned by the runtime (throttle suppression
  windows, pending debounce batches). [002 §3](./002-runtime-delivery.md).
- **Event** — A durable, persisted record (one row in `monitor_events`) materialized from an
  emitted observation. Has its own event ID. [002 §5](./002-runtime-delivery.md). (SP3)
- **Snapshot / diff** — Stored text for an observed object, keyed by
  `(workspacePath, monitorId, objectKey)`; a textual diff is computed against the prior
  snapshot. [002 §5.2](./002-runtime-delivery.md). (SP5)

## Sessions & hooks

- **Agent session** — A tracked agent run, identified by `(adapter, hostSessionId)`. Reopening
  the same pair resumes the record. [002 §6.1](./002-runtime-delivery.md).
- **Lead vs subagent session** — Events project into **lead** sessions only (plus
  `workspacePath: null` leads for global visibility); subagent sessions are tracked but not
  auto-projected. [002 §6](./002-runtime-delivery.md).
- **Projection** — Inserting `session_event_state` rows that link a durable event to the
  matching lead sessions. [002 §6](./002-runtime-delivery.md). (PP4)
- **Unread / Claimed / Acknowledged** — Three **distinct** per-session states. Unread = not
  yet acknowledged; Claimed = surfaced at least once at a delivery lifecycle; Acknowledged =
  explicitly marked read. Claiming never acknowledges. [002 §7, §9.4](./002-runtime-delivery.md). (SP4, BP2)
- **Delivery lifecycle** — One of `turn-interruptible`, `turn-idle`, `post-compact`; the
  moment at which pending work may be claimed and surfaced. [002 §9](./002-runtime-delivery.md).
- **Hook state** — The per-session `hook-state.json` summarizing unread counts and pending
  flags for the integrating agent. [002 §8](./002-runtime-delivery.md).
- **Adapter** — The integration shim mapping a host agent's lifecycle to delivery lifecycles
  and hook-state paths (e.g. `claudeCodeAdapter`). [002 §"Agent Integration"](./002-runtime-delivery.md).
- **Claim** — Advisory surfacing of pending work to an agent at a lifecycle point. Marks rows
  claimed; does not imply completion or acknowledgement. [002 §9.4](./002-runtime-delivery.md). (BP2)

## Agent-facing interaction & ephemeral monitors (target)

- **Agent-facing verb (target)** — A **read-only or declaration-only** `agentmonitors` command an
  agent uses to _act on_ a pushed signal (`snapshot`, `diff`, `summary`) or _declare_ a watch
  (`watch`) / inspect state (`inspect`). Never claims, acknowledges, advances a cursor, or triggers a
  fresh observation. [007 §2–§3](./007-agent-facing-interaction.md),
  [005 §14](./005-cli-reference.md). (PP9, PP10, AP6)
- **Ephemeral monitor (target)** — An **agent-declared, session-scoped** monitor handled by the
  **same daemon and pipeline** as a persistent `MONITOR.md` monitor; it differs only in authoring
  path (declared at runtime, not a file) and lifetime (bound to the declaring session, reaped when it
  ends). Not a parallel system. [007 §4](./007-agent-facing-interaction.md). (AP7, PP9)
- **Armed (condition met but not yet fired) (target)** — A change the daemon has **detected** but is
  **holding** before delivery — inside a high-urgency settle window, a debounce/throttle/rollup
  window, or a recorded `net`/Interpret suppression. Distinct from _pending_ (fired, unread) and
  _received_ (delivered). Surfaced by `agentmonitors inspect`.
  [007 §5.2](./007-agent-facing-interaction.md). (PP7)
- **Multi-host adapter matrix (target)** — The per-host requirements a Codex or Cursor adapter (CLI +
  desktop) must satisfy under the `AgentRuntimeAdapter` contract, and the classification of which
  parts of [006](./006-agent-integration.md) are host-generic vs Claude-specific.
  [006 §11](./006-agent-integration.md). (AP3, AP6)

## Legacy

- **Inbox item** — A record in the _separate_ legacy inbox state machine
  (`queued → acked → in-progress → completed|failed → archived`), exposed via
  `agentmonitors inbox …`. **Not** the authoritative runtime delivery path.
  [002 §12](./002-runtime-delivery.md). (AP2)
