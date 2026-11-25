## 2026-11-06 — Bound script scheduling and fixture startup (004 §2.10) — Refs #458

Script files run serially to bound nested Vitest/package-manager resource contention.
An actual-worker capacity-lease test enforces this policy rather than inspecting config
text. Traced one-CPU runs show roughly 3s pre-command startup plus an unchanged 1s jq
verdict; the private negative fixture now explicitly separates 4s of framework allowance
from that 1s command, for a 5s complete-phase bound, 1s cleanup and 7s outer test.
This supersedes the former combined 4s/6s fixture assumption only. Exact 1,000ms jq,
child/query helper contracts, complete-phase/terminal-worker checks, both positive
canonical controls, package `pnpm test` scheduling and aggregate/workflow surface remain.

