/**
 * Guard: a workspace check run from the main checkout must not walk the worktrees
 * nested inside it (spec 008 §10, "Local gate ≡ CI gate").
 *
 * Worktrees live at `<checkout>/.claude/worktrees/<name>`, so `eslint .` and
 * `prettier --check .` reach every worktree's copy of the repo unless a rule stops
 * them. CI has no such directory, so running `pnpm check` there cannot notice a
 * missing rule. These tests ask each tool directly, which needs no file on disk.
 *
 * @see https://git-scm.com/docs/git-check-ignore
 * @see https://prettier.io/docs/ignore
 * @see https://eslint.org/docs/latest/integrate/nodejs-api#-eslintispathignoredfilepath
 */
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  gitCheckIgnore,
  prettierFileInfo,
  REPO_ROOT,
} from './lib/ignore-rule-probes.mjs';

const NESTED_WORKTREE = join('.claude', 'worktrees', 'probe');

const NESTED_CODE_PATHS = [
  join(NESTED_WORKTREE, 'libs', 'core', 'src', 'index.ts'),
  join(NESTED_WORKTREE, 'scripts', 'release-gate.mjs'),
];

const NESTED_OTHER_PATHS = [
  // Exempt from the format gate at the root, but only by an anchored rule, so a
  // worktree's copy is formatted unless the whole directory is skipped.
  join(NESTED_WORKTREE, 'apps', 'website', 'src', 'pages', 'docs', 'index.md'),
  join(NESTED_WORKTREE, '.agentmonitors', 'sessions', 'id', 'hook-state.json'),
];

// The first call loads the root config, which imports the whole typescript-eslint
// preset and can outrun vitest's 5s default on a busy machine.
const ESLINT_TIMEOUT_MS = 30_000;

const eslint = new ESLint({ cwd: REPO_ROOT });

describe.each([...NESTED_CODE_PATHS, ...NESTED_OTHER_PATHS])(
  '%s',
  (nestedPath) => {
    // Reads the matching source as well as the verdict: an entry in
    // `.git/info/exclude` must not make this pass locally and fail in CI.
    it("is ignored by the repo's own .gitignore", () => {
      expect(gitCheckIgnore(nestedPath, '--verbose').stdout).toMatch(
        /^\.gitignore:\d+:/,
      );
    });

    it('is skipped by the Prettier CLI that `check:format` runs', () => {
      expect(prettierFileInfo(nestedPath)).toMatchObject({ ignored: true });
    });
  },
);

// Code paths only: ESLint also reports a file no config matches as ignored, so
// asking about Markdown or JSON would pass with the rule removed.
it.each(NESTED_CODE_PATHS)(
  '%s is skipped by the ESLint that `check:lint-ts` runs',
  async (nestedPath) => {
    await expect(eslint.isPathIgnored(nestedPath)).resolves.toBe(true);
  },
  ESLINT_TIMEOUT_MS,
);

describe('the ignore rules stay narrow', () => {
  const SOURCE_FILE = join('libs', 'core', 'src', 'index.ts');
  // Lives beside the ignored directory, and is what a rule on all of `.claude/` would hide.
  const MONITOR = join('.claude', 'monitors', 'spec-changes', 'MONITOR.md');

  it(
    'still formats and lints source files',
    async () => {
      expect(prettierFileInfo(SOURCE_FILE)).toMatchObject({ ignored: false });
      await expect(eslint.isPathIgnored(SOURCE_FILE)).resolves.toBe(false);
    },
    ESLINT_TIMEOUT_MS,
  );

  it('still formats monitor definitions tracked under .claude/', () => {
    // Exit 1 means "not ignored". `--verbose` would exit 0 on a `!` re-include.
    expect(gitCheckIgnore(MONITOR).status).toBe(1);
    expect(prettierFileInfo(MONITOR)).toMatchObject({ ignored: false });
  });
});
