---
'@agentmonitors/core': minor
---

Make `urgency` optional in monitor frontmatter, defaulting to `normal` (001 §3)

`urgency` was a required field. It is now optional: an omitted `urgency` flattens to the degenerate
band `normal..normal`, so the minimal valid monitor is just a `watch:` block and a body. This is the
gradual-reveal floor — an author opts into mid-session interruption (`urgency: high`) or a `lo..hi`
escalation band only when needed. Backward compatible: every monitor that already declares an
`urgency` level or band is unchanged, and the parsed `MonitorFrontmatter` shape is identical
(`urgency`/`urgencyMax` are still always present after parsing). The default is deliberately
`normal`, not `high`.
