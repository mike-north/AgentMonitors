/** Real Git/process boundary regressions for the recoverable error contract (003 §6.5). */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DIAGNOSTIC =
  'incoming-changes: could not resolve the configured ref to a commit. Check watch.cwd (an accessible Git repository), watch.branch (default HEAD), and that git is installed. No baseline was established or advanced; continuous monitoring will retry.';
const roots: string[] = [];
const sourceUrl = pathToFileURL(
  path.resolve(import.meta.dirname, 'index.ts'),
).href;

/** Each fixture owns its repository, Git config and executable shims. */
function fixture(): { root: string; repo: string; sha: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'incoming-unavailable-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(path.join(repo, 'a.txt'), 'before\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'Initial fixture']);
  return { root, repo, sha: git(repo, ['rev-parse', 'HEAD']) };
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Mike North',
      '-c',
      'user.email=michael.l.north@gmail.com',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/** A fresh Node child captures native execFileSync stderr, which console spies miss. */
function observe(
  config: Record<string, unknown>,
  previousState?: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import source from ${JSON.stringify(sourceUrl)};
    const {config, previousState} = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify({result: await source.observe(config, {previousState, now: new Date('2026-01-01T00:00:00Z')})})); }
    catch (error) { console.log(JSON.stringify({error: error.message})); }
  `,
      JSON.stringify({ config, previousState }),
    ],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  return JSON.parse(child.stdout);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('incoming-changes recoverable failures', () => {
  it.each([
    'missing',
    '--help',
    '--git-dir=/etc/passwd',
    'HEAD^{tree}',
    'HEAD:a.txt',
  ])(
    'rejects unavailable or non-commit ref %s with the exact static diagnostic',
    (branch) => {
      const { repo } = fixture();
      expect(observe({ paths: ['.'], cwd: repo, branch })).toEqual({
        error: DIAGNOSTIC,
      });
    },
  );

  it('rejects non-repo, absent cwd and missing git without child leakage', () => {
    const { root, repo } = fixture();
    expect(observe({ paths: ['.'], cwd: root })).toEqual({ error: DIAGNOSTIC });
    expect(observe({ paths: ['.'], cwd: path.join(root, 'absent') })).toEqual({
      error: DIAGNOSTIC,
    });
    expect(
      observe({ paths: ['.'], cwd: repo }, undefined, { PATH: root }),
    ).toEqual({ error: DIAGNOSTIC });
  });

  it('baselines a commit and annotated commit tag, and keeps a missing-old-SHA rebaseline quiet', () => {
    const { repo, sha } = fixture();
    git(repo, ['tag', '-a', 'release', '-m', 'Commit tag']);
    const scope = { paths: ['.'], cwd: repo };
    expect(observe(scope)).toEqual({
      result: { observations: [], nextState: { ref: sha } },
    });
    expect(observe({ ...scope, branch: 'release' })).toEqual({
      result: { observations: [], nextState: { ref: sha } },
    });
    expect(observe(scope, { ref: '0'.repeat(40) })).toEqual({
      result: {
        observations: [],
        nextState: { ref: sha },
        outcome: 'rebaselined',
      },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a per-file show failure quiet while retaining its observation',
    () => {
      const { root, repo, sha } = fixture();
      writeFileSync(path.join(repo, 'a.txt'), 'after\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'Advance fixture']);
      const next = git(repo, ['rev-parse', 'HEAD']);
      const shim = path.join(root, 'bin');
      mkdirSync(shim);
      // Forward real resolution/diff; fail only the snapshot read at the native boundary.
      const executable = path.join(shim, 'git');
      writeFileSync(
        executable,
        `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args[0]==='show'){process.stderr.write('fatal: snapshot unavailable\\n');process.exit(1);}\nconst r=spawnSync('git',args,{env:{...process.env,PATH:process.env.ORIGINAL_PATH},stdio:'inherit'});process.exit(r.status ?? 1);\n`,
      );
      chmodSync(executable, 0o755);
      const actual = observe(
        { paths: ['a.txt'], cwd: repo },
        { ref: sha },
        {
          PATH: `${shim}${path.delimiter}${process.env['PATH'] ?? ''}`,
          ORIGINAL_PATH: process.env['PATH'] ?? '',
        },
      );
      expect(actual.result.nextState).toEqual({ ref: next });
      expect(actual.result.observations).toEqual([
        {
          title: 'Incoming change: a.txt (modified)',
          summary: 'Incoming change: a.txt (modified)',
          changeKind: 'modified',
          objectKey: 'a.txt',
          queryScope: { path: 'a.txt' },
          payload: { path: 'a.txt', status: 'M', fromRef: sha, toRef: next },
        },
      ]);
    },
  );
});
