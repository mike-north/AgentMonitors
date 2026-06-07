---
'@mike-north/core': minor
---

Remove the `event-kind` frontmatter field and its runtime counterparts (`eventKind`, `event_kind`) from the entire pipeline. The field was never surfaced in a delivered signal. Affected: frontmatter schema, JSON Schema required-field list, `monitor_events` and `inbox_items` DB columns, CLI scan output and filter options.
