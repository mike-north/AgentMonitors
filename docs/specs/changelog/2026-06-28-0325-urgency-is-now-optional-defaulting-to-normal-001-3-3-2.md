## 2026-06-28 — `urgency` is now optional, defaulting to `normal` (001 §3, §3.2)

Ergonomics: `urgency` was a required frontmatter field; it is now **optional** and defaults to the
degenerate band `normal..normal` when omitted, so the minimal valid monitor is a `watch:` block plus
a body. [001 §3](./001-monitor-definition.md) (field table + verified note) and §3.2 updated.
Backward compatible — every monitor that declares `urgency` (a level or a `lo..hi` band) is
unchanged. The default is intentionally `normal` (not `high`): the simplest monitor does not
interrupt the current turn; an author opts into mid-session interruption with `urgency: high`
(gradual reveal). Per maintainer decision, 2026-06-28. Part of the "simple cases feel simple"
authoring-ergonomics pass.

