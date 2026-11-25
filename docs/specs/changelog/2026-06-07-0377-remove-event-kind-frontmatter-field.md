## 2026-06-07 — Remove `event-kind` frontmatter field

- `event-kind` (and its runtime counterparts `eventKind` / `event_kind`) are **removed** from the
  schema and the entire pipeline. The field was never surfaced in a delivered signal and served no
  runtime purpose. Affected: frontmatter schema ([001 §3](../001-monitor-definition.md)), required
  fields for JSON Schema generation ([003 §2](../003-source-plugins.md)), `monitor_events` and
  `inbox_items` DB columns ([002 §5/§12](../002-runtime-delivery.md)), delivery meta key table
  ([006 §4.2](../006-agent-integration.md)), CLI scan output and filter options
  ([005 §5/§9](../005-cli-reference.md)). No DB migration — a local no-users project. Minor
  `@agentmonitors/core` changeset.

