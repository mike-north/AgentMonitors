---
'@agentmonitors/cli': patch
'@agentmonitors/core': minor
---

Upgrade direct validation to patched Zod 4 and raise MCP SDK and TOON dependency floors. Exported schema objects now use Zod 4 schema types; parsed monitor fields and authored validation messages retain their contracts. Preserve mapping-only Shape admission by rejecting YAML timestamp Date values before object normalization; the exported Shape validator uses a preprocessing pipe with unchanged authored input and parsed output types. The MCP SDK v3 compatibility path and external cel-js lodash dependency remain separately documented security limitations.
