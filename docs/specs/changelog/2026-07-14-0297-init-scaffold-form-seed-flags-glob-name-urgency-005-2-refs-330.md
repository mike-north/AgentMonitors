## 2026-07-14 — `init` scaffold form: seed flags `--glob`/`--name`/`--urgency` (005 §2) — Refs #330

A blind DX study (5 subjects) found 4 of 5 independently discarded and rewrote the scaffolded
`MONITOR.md` body because `init <name> --type <source>` had no way to seed the fields the user
had already stated — only `--type` was configurable, so every author hand-edited `name:`,
`urgency:`, and the source's path-pattern field by hand (error-prone, per the issue's cited
frontmatter-authoring footguns).

- **005 §2 — new optional flags on the scaffold form (current).** `--glob <pattern>`
  (repeatable), `--name <name>`, `--urgency <low|normal|high>` each replace the corresponding
  template field (value-preserving; `--name`/`--glob` re-emitted as single-quoted YAML scalars) when passed; omitting all three keeps `init <name>` byte-for-byte
  unchanged (unaffected regression coverage: `apps/cli/src/commands/cli.integration.test.ts`
  "AC4 regression"). `--glob` seeds `watch.globs` for `file-fingerprint` and `watch.paths` for
  `incoming-changes` — the two source types whose template has a path-pattern list — and is
  rejected with a clear stderr message (no directory created) for any other `--type`.
- **Bootstrap form unaffected (non-goal).** The bare `init` bootstrap path (§2 "Bootstrap form")
  accepts but does not consume the three seed flags — only the named scaffold form does.
- **Template audit (current, no spec change needed).** The per-source template table (005 §2
  "Templates") was re-verified against this entry's DX-study finding: each of the five
  `--type` templates already produces a source-appropriate `watch:` block with no cross-type
  leftover fields (`apps/cli/src/commands/cli.integration.test.ts` "AC1" parametrized
  regression, one case per source).

