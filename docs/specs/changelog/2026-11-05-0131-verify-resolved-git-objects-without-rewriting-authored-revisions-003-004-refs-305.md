## 2026-11-05 — Verify resolved Git objects without rewriting authored revisions (003–004) — Refs #305

Resolve an authored incoming-changes revision unchanged to one complete SHA-1/SHA-256 object ID,
then separately peel that ID to a commit. Suffixing arbitrary input can turn a commit-type check
into a blob filename or alter a commit-message search regex. Both hash formats now require real
source/built-source/CLI regressions for suffix-named blob paths and valid commit-search expressions,
with ordinary commit/tag/extended-expression controls. The accepted #555 ordinary error diagnostic,
baseline/state/history contracts, quiet recovery and public API remain unchanged.

