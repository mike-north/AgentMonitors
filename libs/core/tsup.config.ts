import { defineConfig } from 'tsup';

/**
 * Build of the published `@agentmonitors/core` library (ESM + CJS).
 *
 * The CEL implementation (`cel-js`) and its parser stack (`chevrotain`, the
 * `@chevrotain/*` packages, `lodash-es`, `ramda`) are bundled into the output
 * rather than listed as runtime dependencies. They are exact-pinned upstream,
 * so a consumer's install would otherwise resolve the vulnerable
 * `lodash-es@4.17.21` (GHSA-r5fr-rjxr-66jc); this workspace's
 * `pnpm-workspace.yaml` override fixes only this repository's own install and
 * does not travel with a published package. Bundling ships the patched version
 * this workspace resolves. These packages are therefore `devDependencies`, and
 * their license notices are shipped in `THIRD_PARTY_NOTICES.md`. The live
 * `check:dependency-audit` gate builds fresh metafiles and checks actual bundled
 * inputs against exact locked versions, including default-inlined imports and
 * injected tool code. These selectors declare intent; they do not define audit
 * scope. Unused selectors are reported without failing the advisory gate.
 *
 * Production dependencies outside these selectors stay external and are
 * installed by the consumer. Core's
 * public types never mention these packages, so declarations are unaffected.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  platform: 'node',
  noExternal: ['cel-js', 'chevrotain', /^@chevrotain\//, 'lodash-es', 'ramda'],
  dts: false, // tsc handles declarations for api-extractor
});
