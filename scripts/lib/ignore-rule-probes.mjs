// Probes that ask a tool whether a path is ignored, for guards on this repo's
// verification gate (spec 008 §10). Files that exist only on a developer's
// machine are absent from CI, so running the gate there cannot notice a missing
// rule. Asking the rules directly needs no file on disk and so fails in CI too.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const PRETTIER_CLI = createRequire(import.meta.url).resolve(
  'prettier/bin/prettier.cjs',
);

/** `git check-ignore` for a path, as if nothing were tracked. Exit 1 means not ignored. */
export function gitCheckIgnore(repoRelativePath, ...flags) {
  return spawnSync(
    'git',
    ['check-ignore', '--no-index', ...flags, repoRelativePath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

/**
 * Prettier's verdict for a path, as `check:format` reaches it from the repo root.
 *
 * Runs the CLI entrypoint under Node: the `.bin` shim is not executable this way
 * on Windows, where pnpm generates `.cmd` and `.ps1` wrappers instead.
 */
export function prettierFileInfo(repoRelativePath) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [PRETTIER_CLI, '--file-info', repoRelativePath],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ),
  );
}
