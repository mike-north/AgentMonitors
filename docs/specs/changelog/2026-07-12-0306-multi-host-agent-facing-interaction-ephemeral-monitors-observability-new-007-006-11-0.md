## 2026-07-12 — Multi-host agent-facing interaction, ephemeral monitors & observability (new 007; 006 §11; 005 §14) — Refs #259

Formalizes the "Decided shape (2026-06-19)" of Epic #259 into normative spec text. **Spec-only; every
new rule is marked _target_** (nothing here ships yet), grounded on the ratified invariants PP9, PP10,
AP7, NP5 (000-principles, #191). Scope is **local hosts only** — the web-agent defer stands (closed
#126); push-not-poll is unchanged.

### New doc: 007 — Agent-Facing Interaction, Ephemeral Monitors & Observability (target)

Owns the **agent → daemon** direction (the complement of 006's daemon → agent delivery), given its
own numbered doc because request/declaration and delivery are opposite directions with different
contracts:

- **§2–§3 — agent-facing act-on-signal verbs.** Read-only `snapshot` / `diff` (point-to-point) /
  `summary` that read durable state (snapshots, events, cursors) without re-observing and without
  touching delivery state (no claim/ack/cursor move, SP4/BP2). Async-biased; transport (loopback
  HTTP vs the Unix socket) is an implementation detail. An agent acts **in response to a pushed
  signal**, never on a timer of its own (PP9, new non-property NP-AF).
- **§4 — ephemeral monitors.** Agent-declared, session-scoped monitors on the **same daemon and
  pipeline** as persistent `MONITOR.md` monitors (AP7): declared via `watch`, validated by the same
  `validateScope` path, namespaced runtime identity, reaped when the declaring session ends, durable
  across restart while the session lives, all deterministic work daemon-owned (PP9/PP10). Composes
  with dependent chains (#124) and per-binding fan-out (#258) rather than diverging.
- **§5 — observability surface.** `inspect` returns three **distinct** buckets — received / pending /
  **armed-but-not-yet-fired** — where "armed" is derived from the already-durable hold substrate
  (settle/debounce/throttle/rollup windows, `net`/Interpret suppression), a pure read that introduces
  no new watching.

### 006 §11 — Multi-host adapter matrix (target)

Generalizes the single `claudeCodeAdapter` to Claude Code / Codex / Cursor, each CLI + desktop. Fixes
the per-host adapter contract (lifecycle mapping, delivery lifecycle points, session identity,
workspace binding, delivery-surface state, availability/fallback), a **host-generic vs
Claude-specific** classification table of the current 006, the six-surface matrix (Claude current;
Codex/Cursor cells pinned by a per-host probe), the CLI-vs-desktop single-adapter rule, and the
invariant that delivery semantics never change across hosts. A new host is a new adapter, never a
runtime-core change (AP3).

### 005 §14 — Agent-facing verb command sections (target)

Concise target command sections for `snapshot`, `diff`, `summary`, `watch` (declare/list/cancel), and
`inspect`, each referencing 007 for the contract (mirroring how §13 channel references 006 §4). The
prior §14 (Exit codes & diagnostics) is renumbered §15; no external cross-reference targeted the old
§14.

### Supporting updates

- **000 §7** cross-reference index — new 007 row; AP3 added to the 006 row.
- **README** reading-order table + normative range (000–007).
- **glossary** — new terms: agent-facing verb, ephemeral monitor, armed (condition-met-but-not-fired),
  multi-host adapter matrix.
- **roadmap** — gaps G16 (act-on-signal verbs), G17 (ephemeral monitors), G18 (observability),
  G19 (Codex adapter), G20 (Cursor adapter), each with governing property, files, and proof.

Spec-only — no implementation or published-package behavior change, so no changeset. Concrete child
implementation issues are filed from this landed spec per the epic's "spec precedes build" gate.
Refs #259.

