## 2026-06-29 — `file-fingerprint` ignore exclude globs (003 §3.1, §3.2) — Refs #232

`file-fingerprint` now accepts an optional `ignore: string[]` exclude-glob array alongside `globs`.

- **003 §3.1 — clarified and extended.** A path that matches `globs` but also matches any `ignore`
  pattern is omitted from both the initial baseline and later change detection. Ignore patterns are
  resolved against the same base as `globs`; there is no gitignore-style negation or separate base.

- **Self-trigger guidance.** The docs now call out the common footgun where a monitor watching a
  broad glob writes its own notification artifact back into that glob, causing a re-fire loop. The
  recommended fixes are to write outside the watched tree or exclude generated outputs with `ignore`.

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` ("ignore exclude globs") asserts an
  ignored matching file is absent from baseline and does not emit on change, while a non-ignored
  matching file still emits normally. `apps/cli/src/commands/cli.integration.test.ts` pins
  `source list` exposure of the new field.

