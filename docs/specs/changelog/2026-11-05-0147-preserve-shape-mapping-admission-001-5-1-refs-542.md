## 2026-11-05 — Preserve Shape mapping admission (001 §5.1) — Refs #542

Clarify the current mapping-only contract: YAML timestamps are scalar declarations
and must be rejected, including the Date values produced by the YAML loader.
Restore this rejection before Zod 4 object normalization can erase the scalar to
`{}`. Valid mappings, omission, authored input types, and parsed output types are
unchanged. The exported Shape validator now uses a preprocessing pipe; its API
report records that schema-composition surface.

