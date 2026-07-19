---
'@agentmonitors/core': minor
'@agentmonitors/source-command-poll': patch
'@agentmonitors/source-api-poll': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Use the monitor's authored name as a delivered event's title, instead of the source's
implementation detail. A `command-poll` monitor announced itself with its raw argv as both `title`
and `summary` — a GitHub poller with a large `jq` program produced a ~400-character headline that
was entirely its own implementation, on every delivery, while the author's perfectly good `name:`
appeared nowhere.

- The runtime now decides an event's `title` at materialization: the monitor's authored `name` when
  present, otherwise the source-provided title unchanged (the documented fallback). Because the
  choice happens once in the core, the hook and channel transports carry the identical headline.
- The source's own per-object text is not lost — it remains the event `summary`, and the full source
  identity remains on `objectKey` and in `payload` for debugging and querying.
- Sources that interpolate an `objectKey` into human-facing text now bound it with the new
  `displayObjectKey` helper (unchanged at or below 60 characters, otherwise a prefix ending in `…`),
  so even a nameless monitor's fallback title is headline-sized. Applied by `command-poll`,
  `api-poll`, and keyed-collection change detection, which bounds only the monitor-scope half of a
  `<scope>#<key>` identity so the informative per-item key is always rendered whole.
- Both injecting transports' shared per-event block now renders the event `summary` on its own line
  beneath the title (omitted when the two are identical, which is the nameless-monitor case). This
  keeps a per-object source's delivery self-sufficient: the block names both what the monitor is for
  and which object moved.
- `displayObjectKey` is an additive `@agentmonitors/core` public export (minor bump); existing
  consumers are unaffected.

See docs/specs/002-runtime-delivery.md §5.4 and docs/specs/003-source-plugins.md §2.8.
