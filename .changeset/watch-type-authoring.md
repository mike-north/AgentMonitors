---
'@agentmonitors/core': minor
---

Replace the mechanism-first `source:` + `scope:` frontmatter pair with an intent-first `watch:` block. `watch.type` names the observation source (kebab-case, validated); per-source config lives flat alongside `type` inside `watch:`. This is a hard cut with no back-compat: monitors using the old `source:`/`scope:` shape no longer validate. `MonitorFrontmatter` and `monitorFrontmatterSchema` reflect the new shape.
