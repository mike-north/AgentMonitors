---
'@agentmonitors/core': patch
---

Bundle the CEL parser and its dependencies into the published build instead of installing them separately. A fresh install of `@agentmonitors/core` no longer pulls in `lodash-es@4.17.21` (GHSA-r5fr-rjxr-66jc) through `cel-js` and `chevrotain`. The bundled packages' license notices ship in `THIRD_PARTY_NOTICES.md`. CEL behavior is unchanged.
