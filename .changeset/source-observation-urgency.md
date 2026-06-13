---
'@agentmonitors/core': minor
---

Monitor `urgency` frontmatter now accepts an authored band (`urgency: normal..high`); a bare scalar
is the degenerate band `x..x`. A source observation may carry an optional `salience`, and the runtime
resolves the effective urgency as `clamp(salience ?? band.lo, band.lo, band.hi)` — so a source can
escalate a single observation only within the author's band, clamping outside it. An escalated
observation arriving in a held debounce batch flushes the whole batch early (it is not split).
