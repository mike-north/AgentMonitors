---
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
---

Fix spec 003 authoring examples to use the correct `watch:` + `type:` form (the historical `scope:` key was never valid and caused validation failures for anyone copying those examples). `agentmonitors source list` text output now prints `Config fields:` instead of `Scope fields:`; validation error paths now reference `watch/…` instead of `scope/…` so authors see the real YAML key name in error messages.
