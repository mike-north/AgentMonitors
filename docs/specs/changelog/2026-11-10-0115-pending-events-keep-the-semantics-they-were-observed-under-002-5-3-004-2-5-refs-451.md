## 2026-11-10 — Pending events keep the semantics they were observed under (002 §5.3, 004 §2.5) — Refs #451

States a contract the runtime already satisfied: a pending event is delivered with the urgency,
title and body it was materialized under, whatever edits are made to the monitor afterwards. The
reported escalation and body swap do not reproduce on current main; delivery renders the stored
event row on every surface, and a held debounce batch carries its own definition snapshot. Adds
real-runtime regression scenarios (004 §2.5) and a read-only `explain` diagnostic backed by a
nullable `monitor_events.definition_fingerprint` column that counts pending events predating the
current definition. The fingerprint covers urgency, body, name, the source's parsed configuration
except its scheduling `interval`, `shape`, `payload` and `baseline-strategy` (so a command or `--jq`
edit is flagged; `notify`, `tags` and cadence edits are not), and the count is a total
rather than bounded by the event limit. The diagnostic never gates delivery; rows without a
fingerprint read as unknown.

