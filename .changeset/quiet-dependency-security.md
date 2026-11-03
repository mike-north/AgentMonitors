---
'@agentmonitors/cli': patch
'@agentmonitors/core': minor
---

Upgrade direct validation to patched Zod 4 and raise MCP SDK and TOON dependency floors. Exported schema objects now use Zod 4 schema types; parsed monitor fields and authored validation messages retain their contracts. The MCP SDK v3 compatibility path and external cel-js lodash dependency remain separately documented security limitations.
