/**
 * Child-process tests load the same source as Vitest, without rebuilding or
 * trusting a stale dist tree. Node 24 transforms parameter properties; this
 * narrowly maps the source tree's emitted .js specifiers back to TypeScript.
 */
import { URL } from 'node:url';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const sourceRoot = new URL('../../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('.') || specifier.startsWith('file:')) &&
      specifier.endsWith('.js')
    ) {
      const target = new URL(specifier, context.parentURL);
      const source = new URL(target.href.replace(/\.js$/, '.ts'));
      if (source.href.startsWith(sourceRoot) && existsSync(source))
        return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
