## 2026-11-07 — Build incoming-changes before its compiled tests (004 §2.9) — Refs #560

The incoming-changes Nx test target requires both dependency builds and its own build because
the revision-expression suite executes `dist/index.js`. Require a first-attempt cold-target
pass with caching disabled, and an own-build-edge-only reversion that exposes the six compiled
failures while the 52 controls pass. Direct vitest still consumes prebuilt output; no build
moves into test code. Source behavior, public API, feature tests and global Nx defaults remain
unchanged.

