/**
 * Guard: this repo's verification gate must not depend on Agent Monitors'
 * own runtime state (spec 008 §10, "Local gate ≡ CI gate").
 *
 * This repo dogfoods its own plugin, so the runtime writes
 * `<workspace>/.agentmonitors/sessions/<id>/hook-state.json` into any checkout
 * where a session is open (spec 002 §11.3). `prettier --check .` then fails on
 * those files: `JSON.stringify` output has no trailing newline. CI never has
 * such a file, so running `pnpm check` there cannot notice a missing ignore
 * rule. These tests ask the ignore rules directly, which needs no file on disk
 * and so fails in CI too, and never touches a live session's state.
 *
 * The probe paths come from the adapter that decides the real location, so
 * moving the directory fails here rather than quietly reopening the drift.
 *
 * @see https://git-scm.com/docs/git-check-ignore
 * @see https://prettier.io/docs/ignore
 */
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../libs/core/src/adapter/claude.js';
import {
  gitCheckIgnore,
  prettierFileInfo,
  REPO_ROOT,
} from './lib/ignore-rule-probes.mjs';

/** `.agentmonitors/` is rooted at `<workspace-or-cwd>`, which can be any directory. */
const WORKSPACES = [
  ['the checkout root', ''],
  ['a nested working directory', join('apps', 'cli')],
] as const;

function hookStatePathRelativeToRepo(workspace: string): string {
  return relative(
    REPO_ROOT,
    claudeCodeAdapter.defaultHookStatePath({
      workspacePath: join(REPO_ROOT, workspace),
      hostSessionId: 'runtime-state-ignored-probe',
    }),
  );
}

describe.each(WORKSPACES)('hook state written in %s', (_label, workspace) => {
  const hookStatePath = hookStatePathRelativeToRepo(workspace);

  // Reads the matching source as well as the verdict: a developer's global
  // excludes file must not make this pass locally and fail in CI.
  it("is ignored by the repo's own .gitignore", () => {
    expect(gitCheckIgnore(hookStatePath, '--verbose').stdout).toMatch(
      /^\.gitignore:\d+:/,
    );
  });

  it('is skipped by the Prettier CLI that `check:format` runs', () => {
    expect(prettierFileInfo(hookStatePath)).toMatchObject({ ignored: true });
  });
});

describe('the ignore rule stays narrow', () => {
  it.each([
    // Monitor definitions are the source-controlled counterpart of this state.
    join('.claude', 'monitors', 'spec-changes', 'MONITOR.md'),
    join('agent-plugins', 'agentmonitors', '.claude-plugin', 'plugin.json'),
  ])('leaves %s tracked', (trackedPath) => {
    // Exit 1 means "not ignored". `--verbose` would exit 0 on a `!` re-include.
    expect(gitCheckIgnore(trackedPath).status).toBe(1);
  });

  it('leaves nothing under .agentmonitors/ committed', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', ':(glob)**/.agentmonitors/**'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(tracked).toBe('');
  });
});
