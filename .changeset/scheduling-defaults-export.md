---
'@agentmonitors/core': minor
---

Export `schedulingDefaults` — the runtime's canonical scheduling and notify default timings
(file-fingerprint poll, api-poll interval, schedule tick cadence, and the high-urgency claim-settle
window) as a single frozen constant. The daemon's scheduler (`service.ts`) now reads these instead of
its own local literals, and timing-aware consumers (the CLI `verify` command sizing its end-to-end
delivery budget) can import the real values rather than re-declaring hand-mirrored copies that
silently drift when a default changes.
