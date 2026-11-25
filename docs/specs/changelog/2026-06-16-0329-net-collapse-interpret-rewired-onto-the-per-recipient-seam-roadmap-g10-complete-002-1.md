## 2026-06-16 — `net` collapse + Interpret rewired onto the per-recipient seam; roadmap G10 complete (002 §1.1.2, §1.1.7, §1.1.8) — Refs #182

Implements roadmap **G10 PR-B** (the final G10 PR), moving the right-of-seam stages of
[002 §1.1](../002-runtime-delivery.md) from the shared baseline onto each recipient's own baseline
cursor. With PR-A's substrate, this flips [002 §1.1.7](../002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)
and [§1.1.8](../002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)
to fully _current_ and **retires roadmap G10**.

- **002 §1.1.7 — `net` collapse is now per-recipient at claim time (Decision Q3).** The shared
  `monitor_events` chain records **every** observation in order regardless of `baseline-strategy`
  (the incremental substrate — precise over cheap), so an away recipient can be served a correct net
  delta against **its own** cursor. `collapseToNetSpan` is removed from the shared `materializeSpan`
  path. At claim, `RuntimeStore.collapseNetForClaim` (driven by `AgentMonitorRuntime.claimDelivery`)
  groups a recipient's unclaimed events per `objectKey`; for a `net` monitor it delivers only the
  **newest** event per object — with its per-recipient `diff_text` recomputed as
  `buildTextDiff(cursor.baselineContent, newestArtifact)` when the group actually collapsed — and
  records the older intermediates **claimed-but-suppressed** on the new
  `session_event_state.net_suppressed_at` column: retained and explainable via `monitor explain`
  (§10.7), excluded from delivery (unread/pending/recap), never a silent drop. `incremental` (default)
  delivers all in order. The per-recipient cursor still advances to the newest claimed artifact
  (`markClaimed`) even when intermediates are suppressed. A within-tick multi-observation burst for one
  object collapses the same way on the per-recipient side (preserving the same-tick semantics the old
  shared `collapseToNetSpan` provided).

- **002 §1.1.8 — Interpret runs once per distinct per-recipient delta (Decision Q4).** `runInterpret`
  groups projected sessions by their distinct `session_event_state.diff_text` and invokes the adapter
  once per distinct delta, recording the verdict on every session in that group. Interpret runs at
  materialize on the per-recipient single-event delta (the common case); a claim-time `net` re-diff
  re-anchors the delivered delta but **does not re-invoke the adapter** unless the collapsed delta
  string differs from what was already interpreted.

- **Persistence.** New `monitor_events.baseline_strategy` (the author-declared strategy persisted on
  each event so the claim-time net decision needs no monitor re-scan) and
  `session_event_state.net_suppressed_at` (the claimed-but-suppressed marker). Both migrate additively
  (`addColumnIfMissing`); legacy rows keep `NULL` (treated as `incremental` / never net-suppressed).
  `monitor_events` ids now use a monotonic ULID factory so `(created_at, id)` ordering reflects
  insertion order within a single tick — the deterministic "newest event per object" tiebreak the net
  collapse and cursor advance both rely on.

- **Backward compatibility.** A `net` monitor with a single (or co-registered) session that never
  misses a window behaves exactly as before — one event per window, `net` ≡ `incremental` in the
  degenerate single-observation span (no diff is rewritten to empty for a baseline event). The
  shared `monitor_events` chain now keeps every intermediate for a `net` monitor (the visible change:
  `listEvents`/`emittedEventIds` report N, not the collapsed 1 — the collapse is per-recipient at
  delivery). The G13 `net` and issue-#180 rollup/`net` runtime tests were updated to assert this
  intentional shared-chain change plus the per-recipient claim-time collapse.

- **Proof.** `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-3 → one net delta + 2
  suppressed/explainable; `incremental` 3-ordered-deltas contrast; missed-nothing degenerate;
  backward-compat degenerate equivalence; co-registered never-miss; shared-chain keeps all N; cursor
  advances past suppressed intermediates; divergent-baseline Interpret → 2 calls, identical → 1
  fanned). Plus the updated `libs/core/src/runtime/service.test.ts` baseline-strategy and rollup tests.
  Files: `libs/core/src/runtime/{service,store,types}.ts`, `libs/core/src/inbox/{schema,db}.ts`.

