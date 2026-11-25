## 2026-06-15 — Author-declared baseline strategy shipped: `incremental` vs `net` (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #171

Moves roadmap **G13** from _target_ to _current_. The `baseline-strategy` frontmatter field is now
implemented; the spec sections that described it as target are flipped to current with `Verified:`
references.

- **001 §3.7 / §7.4 — now current.** The `baseline-strategy` field is an optional
  `z.enum(['incremental', 'net'])` defaulting to `incremental`; omitting it is backward compatible
  with today's sequential, one-event-per-observation delivery. The frontmatter table row drops its
  _Target_ label. Section anchors changed from `#37-baseline-strategy-target` to
  `#37-baseline-strategy-current` (and the §7.4 example from target to current); all cross-references
  in 001/002 were updated to match.
- **002 §1.1.7 — now current.** The two Diff modes are enforced by the runtime: `incremental`
  materializes each observation in a catch-up span as its own ordered delta; `net` collapses the
  span per `objectKey` to a single net delta (the last observation of each object's run, diffed
  against the prior snapshot baseline). Anchor changed to
  `#117-baseline-strategy-per-recipient-diff-semantics-current`.
- **Scope (implementation vs. desired behavior).** The catch-up span collapsed by `net` is the set
  of observations emitted into a single delivery over the runtime's **shared** snapshot baseline. The
  full **per-recipient-baseline seam** — divergent-baseline recipients each receiving an
  independently-spanned Diff — remains _target_ under roadmap **G10**; `baseline-strategy` is the
  author-declared mode that seam will apply per recipient. §1.1.7 and §5.2 say so explicitly.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` (accept/default/reject),
  `libs/core/src/runtime/service.test.ts` ("baseline strategy (G13, 002 §1.1.7)"),
  `apps/cli/src/commands/cli.integration.test.ts` (`validate` accept/reject).

