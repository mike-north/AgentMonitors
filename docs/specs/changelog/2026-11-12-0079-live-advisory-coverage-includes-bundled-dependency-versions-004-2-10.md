## 2026-11-12 — Live advisory coverage includes bundled dependency versions (004 §2.10)

The separate dependency-audit gate covers production dependencies and the exact
runtime/optional closure selected by published tsup builds' `noExternal` selectors.
Moving bundled code to development dependencies does not remove advisory coverage.
Both inventories use the existing scoped, expiring allowlist and fail closed on audit
failures. Loopback registry fixtures cover synthetic bundled advisories and automatic
coverage when `noExternal` gains another package.

