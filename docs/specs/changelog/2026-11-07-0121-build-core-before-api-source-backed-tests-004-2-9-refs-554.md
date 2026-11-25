## 2026-11-07 — Build core before API-source-backed tests (004 §2.9) — Refs #554

The core Nx test target declares both dependency builds and its own build because its runtime
regression suite imports the real API source, which resolves core runtime values through compiled
package exports. Require a cold uncached first-attempt pass, an own-build-edge-only reversion that
reproduces the package-entry module-load failure, and an exact-restored cold pass. Direct Vitest
still requires a prior build; no build moves into tests. Production/test source, module resolution,
public API, preflight behavior and the accepted #561/#562 boundaries remain unchanged.

