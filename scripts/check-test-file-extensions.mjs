// Guard: test/spec files MUST be authored as TypeScript (`*.test.ts` /
// `*.spec.ts`), never as `.js` / `.mjs` / `.cjs`. A JavaScript test file is not
// type-checked and is not excluded from Nx production inputs the way a `.test.ts`
// file is, so it silently weakens both type safety and cache correctness.
//
// File enumeration is delegated to `git ls-files` rather than a manual directory
// walk: that keeps the scan scoped to THIS checkout's tracked/untracked files,
// honors `.gitignore` (node_modules, dist, …), and never descends into nested
// git worktrees (`.worktrees/`, `.codex/`, `.claude/`) or sibling branch
// checkouts — all of which a hand-rolled walk would have to enumerate and
// special-case (and get wrong on case-insensitive filesystems).
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A non-TypeScript test/spec file: `<name>.test.js`, `.spec.mjs`, etc. */
const OFFENDER_PATTERN = /\.(?:test|spec)\.(?:js|mjs|cjs)$/;

/** Files tracked, or untracked-but-not-ignored, in the current checkout. */
function listRepoFiles() {
  const stdout = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

function main() {
  const offenders = listRepoFiles().filter((file) =>
    OFFENDER_PATTERN.test(file),
  );
  if (offenders.length === 0) return;

  console.error(
    'Test files must use the .test.ts / .spec.ts extension so they are type-checked',
  );
  console.error(
    'and excluded from Nx production inputs. Rename these to .test.ts:',
  );
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

main();
