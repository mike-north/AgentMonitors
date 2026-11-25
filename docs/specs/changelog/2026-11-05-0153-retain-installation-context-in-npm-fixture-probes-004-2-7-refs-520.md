## 2026-11-05 — Retain installation context in npm fixture probes (004 §2.7) — Refs #520

The compatibility fixture forwards intercepted install options to its real npm version probe, retaining the isolated working directory and environment required by context-sensitive Corepack dispatch. A named Corepack-layout fixture checks both while delegating the version query to installed npm.

