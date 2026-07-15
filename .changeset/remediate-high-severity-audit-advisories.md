---
'agentmonitors': patch
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
---

Clear this repo's own `pnpm audit --prod` findings (13 high-severity advisories,
down to 0). `@agentmonitors/core` now declares `drizzle-orm@^0.45.2` (previously
`^0.45.1`, below the patched release). `@agentmonitors/cli`'s published bundle now
embeds a patched `fast-uri` and `hono` (pinned forward via a workspace
`pnpm-workspace.yaml` override on the `@modelcontextprotocol/sdk` dependency tree,
since both were bundled at their previously-resolved, vulnerable versions). No
public API or behavior changes.

**Caveat:** the `lodash-es` advisory (GHSA-r5fr-rjxr-66jc, via `cel-js` ->
`chevrotain`) is cleared for this repo's own audit/build, but **not** for an
external `npm install @agentmonitors/core`: `cel-js` is a real, unbundled
dependency of `@agentmonitors/core`, and its latest release (`0.8.2`) pins an
exact `chevrotain@11.0.3`, whose own dependency on `lodash-es` stays below the
patched `4.17.24` even at chevrotain's latest 11.x patch — only `chevrotain@12`
(a breaking upstream release that drops `lodash-es` entirely) clears it for real
consumers. That's outside what a workspace-level `pnpm` override can fix (it only
affects this monorepo's own install), and is tracked as a known upstream-only
gap rather than force-fixed here.
