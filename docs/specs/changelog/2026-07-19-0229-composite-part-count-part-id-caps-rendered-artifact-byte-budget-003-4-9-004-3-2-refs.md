## 2026-07-19 — Composite part-count/part-`id` caps, rendered-artifact byte budget (003 §4.9, 004 §3.2) — Refs #304

Third round of review follow-ups on the #304 bounds, in the same PR before merge.

- **The cumulative byte budget only bounded response-body bytes** — not the assembled composite
  ARTIFACT, part count, request count, or worst-case tick duration. A reviewer reproduced two shapes
  that sailed past it entirely: 100,000 empty-body parts (0 cumulative body bytes) completing
  100,000 requests and producing a 1,699,998-byte baseline, and a single empty-body part with an
  11 MiB `id` producing an 11,534,340-byte baseline — `renderCompositeSnapshot` frames every part
  with `## <id>\n` regardless of body size, and neither the byte counter nor anything else bounded
  that framing overhead or the number of parts.
- **`change-detection.composite.parts` is now capped at 50 entries and each part's `id` at 256
  characters** (§4.9), enforced identically in the JSON Schema (`maxItems`/`maxLength`, so
  `agentmonitors validate`/`monitor test`/`watch declare` reject an over-limit config at authoring
  time) and the parser (`parseCompositeConfig`, defense in depth for a hand-edited `MONITOR.md` that
  skipped validation — 002 §2.2's tick-time isolation still applies as the last line of defense).
  Both reviewer repro shapes above are now rejected at config-parse time, before `observe()` issues
  a single request.
- **The cumulative byte budget now sums each part's RENDERED framed section** (`## <id>\n<body>`,
  via the new `framedPartByteLength` helper) rather than the raw response body, so id-framing
  overhead counts toward the same 10 MiB figure too — closing the gap the part-count/id-length caps
  don't already close on their own. `framedPartByteLength` is a running per-part tally taken during
  observation, before `renderCompositeSnapshot` assembles the final artifact; it does **not** by
  itself match the renderer's output byte-for-byte, because the renderer also inserts `\n\n`
  separators between sections that this per-part helper has no reason to count. A follow-up entry
  below closes that remaining gap with an exact check on the final rendered artifact.
- **The part-count cap also bounds worst-case tick duration** (§4.9): with the existing 5-worker
  composite concurrency bound, a composite resolves or fails in at most `ceil(parts / 5) *
timeout`; at the new 50-part cap and the default 30s timeout, that ceiling is `ceil(50 / 5) * 30s
= 300s` (5 minutes) — a documented, known bound rather than an unbounded function of `parts.length`.
- **004 §3.2** gained required-scenario rows for the part-count/part-`id` caps (including both
  reviewer repro shapes) and renamed the existing cumulative-budget row to reflect the
  rendered-artifact (not body-only) semantics.

(Verified: `plugins/source-api-poll/src/composite.ts`, `MAX_COMPOSITE_PARTS`,
`MAX_PART_ID_LENGTH`, `framedPartByteLength`, `parseCompositeConfig`;
`plugins/source-api-poll/src/index.ts`, `MAX_COMPOSITE_BYTES`, `observeComposite`, `scopeSchema`;
`plugins/source-api-poll/src/index.test.ts`, "composite cumulative byte budget (issue #304 review,
second + third round)", "composite part-count and part-id bounds (issue #304 review, third
round)".)

