## 2026-11-16 — Versioned source-neutral external-event contract is public (002 §2.6, 004 §2.15) — Refs #481

Core now exports the strict `agentmonitors.external-event.v1` envelope validator,
JSON value types, semantic SHA-256 helper over the closed v1 field set, collision-free
source/object key, and structured validation error types. Exact UTF-8 size, scope, JSON-depth,
timestamp, and sequence bounds are enforced without echoing state in failures. This change exposes
the contract only: durable receipts, runtime ingestion, daemon IPC, and CLI submission remain target
behavior in future changes.

