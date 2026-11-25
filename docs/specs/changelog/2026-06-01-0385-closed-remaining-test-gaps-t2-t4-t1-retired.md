## 2026-06-01 — Closed remaining test gaps (T2, T4; T1 retired)

- **T2** — added `RuntimeStore` snapshot tests (save/retrieve + isolation by
  `(workspace, monitor, objectKey)`, SP5) and a runtime test asserting `diffText` is computed
  against the prior snapshot when an object changes.
- **T4** — added standalone CLI integration tests for `schema generate` (and `-o` output) and the
  `session list` → `session close` lifecycle.
- Retired the already-shipped **T1** (`low` urgency, #21) from the roadmap; all tracked test gaps
  (T1–T4) are now closed. Test-only change — no changeset.

