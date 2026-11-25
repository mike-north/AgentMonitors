## 2026-06-15 — file-fingerprint salience policy: `deleted` → `high`, others → default (003 §3.4)

`file-fingerprint` now emits `salience: 'high'` on `deleted` observations (information permanently
lost) and no `salience` on `created`, `modified`, or `descoped` observations (file still exists or
no information lost). This makes RANGE urgency reachable end-to-end with a bundled source: a monitor
authored with `urgency: normal..high` will receive a `high`-urgency delivery on file deletion and a
`normal`-urgency delivery for all other change kinds. Monitors with a bare scalar `urgency` are
unaffected (the degenerate band `x..x` is never escalated — backward compatible per 003 §2.3).

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` — unit tests asserting `salience:
'high'` on `deleted` and absent salience on `modified`, `created`, `descoped`; end-to-end
  integration tests proving the runtime materializes `urgency: 'high'` for a deletion on a
  `normal..high` band monitor and `urgency: 'normal'` for a modification on the same monitor.
- Minor changeset: `@agentmonitors/source-file-fingerprint` (new salience behavior).
- Refs: issue #151.

