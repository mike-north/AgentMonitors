/** Authored revisions retain Git semantics; only a resolved commit may become a baseline. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DIAGNOSTIC =
  'incoming-changes: could not resolve the configured ref to a commit. Check watch.cwd (an accessible Git repository), watch.branch (default HEAD), and that git is installed. No baseline was established or advanced; continuous monitoring will retry.';
const roots: string[] = [];
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Mike North',
  GIT_AUTHOR_EMAIL: 'michael.l.north@gmail.com',
  GIT_COMMITTER_NAME: 'Mike North',
  GIT_COMMITTER_EMAIL: 'michael.l.north@gmail.com',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Two distinct commits prevent a search expression accidentally falling back to HEAD. */
function fixture(format: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'ic-revisions-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: identity,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', `--object-format=${format}`, '-b', 'main');
  writeFileSync(path.join(root, 'payload'), 'ordinary payload\n');
  writeFileSync(
    path.join(root, 'payload^{commit}'),
    'a different blob, not a commit\n',
  );
  git('add', 'payload', 'payload^{commit}');
  git('commit', '-m', 'Initial fixture');
  const initial = git('rev-parse', 'HEAD');
  git('tag', '-a', 'initial-tag', '-m', 'Tag pointing to Initial');
  writeFileSync(path.join(root, 'payload'), 'later payload\n');
  git('add', 'payload');
  git('commit', '-m', 'Later fixture');
  return { root, git, initial, head: git('rev-parse', 'HEAD') };
}

/** Capture native Git stderr for both actual TypeScript source and the published build. */
function observe(entry: string, cwd: string, branch: string) {
  const url = pathToFileURL(path.resolve(import.meta.dirname, entry)).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import source from ${JSON.stringify(url)};
    const config=JSON.parse(process.argv[1]);
    try {console.log(JSON.stringify({result:await source.observe(config,{now:new Date('2000-01-01T00:00:00Z')})}));}
    catch(error){console.log(JSON.stringify({error:error.message}));}
  `,
      JSON.stringify({ paths: ['payload'], cwd, branch }),
    ],
    { encoding: 'utf8', env: identity },
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  return JSON.parse(child.stdout);
}

for (const format of ['sha1', 'sha256']) {
  for (const [surface, entry] of [
    ['source', 'index.ts'],
    ['built', '../dist/index.js'],
  ] as const) {
    describe(`${format} ${surface} revision identity`, () => {
      it('rejects a blob path even when a file exists with a commit-peeling suffix', () => {
        const f = fixture(format);
        expect(
          f.git('cat-file', '-t', f.git('rev-parse', 'HEAD:payload^{commit}')),
        ).toBe('blob');
        expect(observe(entry, f.root, 'HEAD:payload')).toEqual({
          error: DIAGNOSTIC,
        });
      });

      it('preserves a commit-message search expression rather than extending its regex', () => {
        const f = fixture(format);
        expect(f.initial).not.toBe(f.head);
        expect(observe(entry, f.root, ':/Initial')).toEqual({
          result: { observations: [], nextState: { ref: f.initial } },
        });
      });

      it('keeps HEAD, OID, tag and extended-commit controls while rejecting noncommits and ranges', () => {
        const f = fixture(format);
        for (const branch of ['HEAD', f.head])
          expect(observe(entry, f.root, branch)).toEqual({
            result: { observations: [], nextState: { ref: f.head } },
          });
        for (const branch of [
          f.initial,
          'initial-tag',
          'HEAD~1',
          'HEAD^{/Initial}',
        ])
          expect(observe(entry, f.root, branch)).toEqual({
            result: { observations: [], nextState: { ref: f.initial } },
          });
        for (const branch of [
          f.git('rev-parse', 'HEAD:payload'),
          'HEAD^{tree}',
          'HEAD~1..HEAD',
          'missing',
          '--help',
        ])
          expect(observe(entry, f.root, branch)).toEqual({ error: DIAGNOSTIC });
      });
    });
  }
}
