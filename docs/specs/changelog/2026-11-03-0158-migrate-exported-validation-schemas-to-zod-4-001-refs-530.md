## 2026-11-03 — Migrate exported validation schemas to Zod 4 (001) — Refs #530

Direct core and CLI validation uses patched Zod 4. Exported schema types now follow
Zod 4; parsed monitor data and authored messages are unchanged. This dependency
change does not impose input limits or establish safety of SDK v3 compatibility code.

