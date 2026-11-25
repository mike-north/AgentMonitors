## 2026-11-11 — Ephemeral retained-work remediation names `monitor explain` (005 doctor)

Corrected a false statement in 005: `monitor explain <ephemeral id>` fails its definition stage
(there is no `MONITOR.md`) but still lists the monitor's retained record IDs, in text and structured
output. _Current:_ retained-work remediation for a live or retired ephemeral monitor names
`monitor explain <id>` and `monitor history <id>`, not a text-only doctor heading.

