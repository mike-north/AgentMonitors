// Guard: test/spec files MUST be authored as TypeScript (`*.test.ts` /
// `*.spec.ts`), never as `.js` / `.mjs` / `.cjs`. A JavaScript test file is not
// type-checked and is not excluded from Nx production inputs the way a `.test.ts`
// file is, so it silently weakens both type safety and cache correctness.
//
// This walks the repo, ignoring build/vendor/tooling directories, and exits
// non-zero listing any `*.{test,spec}.{js,mjs,cjs}` offenders.
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose contents are never authored test sources. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.worktrees',
  '.codex',
  '.claude',
]);

/** A non-TypeScript test/spec file: `<name>.test.js`, `.spec.mjs`, etc. */
const OFFENDER_PATTERN = /\.(?:test|spec)\.(?:js|mjs|cjs)$/;

/** Recursively collect offending file paths (absolute) under `dir`. */
function collectOffenders(dir) {
  const offenders = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      offenders.push(...collectOffenders(join(dir, entry.name)));
    } else if (entry.isFile() && OFFENDER_PATTERN.test(entry.name)) {
      offenders.push(join(dir, entry.name));
    }
  }
  return offenders;
}

function main() {
  const offenders = collectOffenders(REPO_ROOT);
  if (offenders.length === 0) return;

  console.error(
    'Test files must use the .test.ts / .spec.ts extension so they are type-checked',
  );
  console.error(
    'and excluded from Nx production inputs. Rename these to .test.ts:',
  );
  for (const offender of offenders) {
    console.error(`- ${relative(REPO_ROOT, offender)}`);
  }
  process.exit(1);
}

main();
