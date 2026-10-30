## Why

`claudeCodeAdapter` is the only `AgentRuntimeAdapter`. Epic #259 greenlit three local hosts — Claude
Code, Codex, and Cursor — each in a CLI and a desktop/IDE surface. The adapter contract was written for
one host, so a second adapter has no unambiguous statement of what it must provide, which parts of the
delivery contract it inherits unchanged, and what evidence it needs before it can be called current.

Source: 006 §11 (Multi-Host Adapter Matrix, target) — §11.1 contract dimensions, §11.2
Claude-specific vs host-generic classification, §11.3 matrix, §11.4 CLI vs desktop surfaces, §11.5
semantic invariance, §11.6 validation; 006 §10 (multi-host probe open question); roadmap G19 (Codex)
and G20 (Cursor). Refs #259.

## What Changes

- Restate the adapter contract for N hosts as six explicit dimensions: lifecycle-event mapping,
  delivery lifecycle points with advisory injection, session identity, workspace binding,
  delivery-surface state, and availability/fallback (portable baseline + additive richer transport).
- Make the host-generic vs Claude-specific classification normative.
- Require one adapter per host, branching internally on `surface: 'cli' | 'desktop'` only when the
  host's surfaces expose different mechanisms.
- Require delivery semantics to be invariant across hosts, including agent-facing verbs resolving
  identity through the adapter contract.
- Require per-adapter conformance evidence: a real-input-contract integration test, a binding-probe
  artifact, and semantic-parity proof.
- Ship a Codex adapter (G19) and a Cursor adapter (G20) against that contract. Scope is local hosts
  only (NP5; the web-agent deferral stands, closed #126).

Principles: AP3 (host-agnostic core), PP4, AP6, NP5, BP2, SP4, PP1, PP9. Resolves no contradiction.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delivery/host-adapters`: ADDED multi-host contract requirements (no existing requirement is
  modified).

## Impact

- New `libs/core/src/adapter/codex.ts` and `libs/core/src/adapter/cursor.ts`; adapter registry wiring;
  per-host activation packaging; per-host probe diagnostics (the `experiments/channel-probe` pattern
  generalized).
- New public adapter exports → core API report + changesets.
- `apps/website` host-setup docs; `docs/specs/roadmap.md` G19/G20 retired as each ships.
