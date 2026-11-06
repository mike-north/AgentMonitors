---
'@agentmonitors/cli': patch
'@agentmonitors/core': minor
---

Upgrade direct validation to patched Zod 4 and raise MCP SDK and TOON dependency floors. Exported schema objects now use Zod 4 schema types; parsed monitor fields and authored validation messages retain their contracts. Preserve historical Shape admission by rejecting Date (including YAML timestamps), Map, Set, and objects with callable then/catch before normalization or promise assimilation; synchronous and asynchronous validation return failures for these inputs while retaining other object controls; the exported Shape validator uses a preprocessing pipe with unchanged authored input and parsed output types. The MCP SDK v3 compatibility path and external cel-js lodash dependency remain separately documented security limitations.
