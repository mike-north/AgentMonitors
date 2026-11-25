## 2026-11-12 — Bundled advisory coverage follows actual build inputs (004 §2.10)

Replace selector/closure inventory with fresh esbuild metafiles for every published
tsup build. Default-inlined imports and injected tool code ship even without a
`noExternal` declaration and therefore receive the same exact-version advisory
coverage. After installation, the gate refreshes workspace exports with an uncached,
serialized build, then bundles sequentially for metadata. It fails on build or metadata
errors and never reuses stale artifacts. Unused selectors are informational.
Loopback regressions demonstrate default imports, shims, plugins and stale-output
rejection alongside the existing explicit bundle and allowlist cases.

