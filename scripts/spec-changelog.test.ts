/**
 * The split preserves an immutable source fixture from 1210066fd28f1826aa640b15da6becee2325ba31.
 * The compressed fixture keeps the complete historical bytes available in shallow checkouts.
 * Integration cases exercise the same file-only workflow used for future spec changes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts/spec-changelog.mjs');

/** Every second-level heading terminates an entry; third-level subsections belong to its body. */
function datedEntries(text: string): string[] {
  return text
    .split(/(?=^## )/m)
    .filter((part) => /^## \d{4}-\d{2}-\d{2} /u.test(part));
}

/** A fixture has only the index and entry directory; no generated history is tracked. */
function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-'));
  mkdirSync(path.join(dir, 'docs/specs/changelog'), { recursive: true });
  writeFileSync(
    path.join(dir, 'docs/specs/spec-changelog.md'),
    '# Spec Changelog\n',
  );
  return dir;
}

function entry(dir: string, name: string, text: string): void {
  mkdirSync(path.join(dir, 'docs/specs/changelog'), { recursive: true });
  writeFileSync(path.join(dir, 'docs/specs/changelog', name), text);
}

function run(dir: string, mode = '--check') {
  return spawnSync(process.execPath, [script, mode], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/** Check filesystem destinations independently of assembly, leaving URI schemes and anchors alone. */
function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\n]*?\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1] ?? '')
    .filter(
      (target) => target && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(target),
    );
}

/** Fragments identify sections inside a file; navigation must first reach that file. */
function missingLinks(text: string, base: string): string[] {
  return relativeLinks(text).filter(
    (target) =>
      !existsSync(
        path.resolve(base, decodeURIComponent(target.split(/[?#]/u)[0] ?? '')),
      ),
  );
}

describe('spec changelog', () => {
  it('resolves every relative link from its entry file location', () => {
    const directory = path.join(root, 'docs/specs/changelog');
    const missing = readdirSync(directory).flatMap((name) => {
      const text = readFileSync(path.join(directory, name), 'utf8');
      return missingLinks(text, directory).map(
        (target) => `${name}: ${target}`,
      );
    });
    expect(missing).toEqual([]);
  });

  it('resolves every relative link at the documented generated history location', () => {
    const index = readFileSync(
      path.join(root, 'docs/specs/spec-changelog.md'),
      'utf8',
    );
    const location = /pnpm --silent specs:changelog > ([^`\n]+)/u.exec(
      index,
    )?.[1];
    expect(location).toBeDefined();
    const assembled = run(root, '--assemble');
    expect(assembled.status, assembled.stderr).toBe(0);
    expect(relativeLinks(assembled.stdout).length).toBeGreaterThan(0);
    expect(
      missingLinks(
        assembled.stdout,
        path.dirname(path.resolve(root, location ?? '')),
      ),
    ).toEqual([]);
  });

  it('rebases file links for assembly while retaining fragments, external URLs and anchors', () => {
    const dir = fixture();
    entry(
      dir,
      'links.md',
      '## 2026-11-25 — Links\n\n[Spec](../004-validation-testing.md#5) [Product](../../product/roadmap.md) [Sibling](./other.md) [Bare](other.md) [External](https://example.com/x) [Anchor](#detail)\n',
    );
    expect(run(dir, '--assemble').stdout).toBe(
      '# Spec Changelog\n\n## 2026-11-25 — Links\n\n[Spec](./004-validation-testing.md#5) [Product](../product/roadmap.md) [Sibling](./changelog/other.md) [Bare](./changelog/other.md) [External](https://example.com/x) [Anchor](#detail)\n',
    );
  });

  it('preserves all 387 original headings and bodies byte for byte, with only date sorting', () => {
    const original = gunzipSync(
      readFileSync(
        path.join(
          import.meta.dirname,
          'fixtures/spec-changelog-before-split.md.gz',
        ),
      ),
    ).toString('utf8');
    const entries = datedEntries(original);
    expect(entries).toHaveLength(392);
    const originalHeadings = new Set(
      entries.slice(5).map((part) => part.split('\n')[0]),
    );
    const migratedFiles = readdirSync(path.join(root, 'docs/specs/changelog'));
    expect(
      migratedFiles.filter((name) =>
        originalHeadings.has(
          readFileSync(
            path.join(root, 'docs/specs/changelog', name),
            'utf8',
          ).split('\n')[0],
        ),
      ),
    ).toHaveLength(387);
    // Five later records on main supplement the original 387; preserve all of them.
    expect(
      readdirSync(path.join(root, 'docs/specs/changelog')).filter((name) =>
        /^\d{4}-\d{2}-\d{2}-\d{4}-/u.test(name),
      ),
    ).toHaveLength(392);
    const assembled = run(root, '--assemble');
    expect(assembled.status, assembled.stderr).toBe(0);
    const actual = datedEntries(assembled.stdout);
    // New entries may precede or interleave the historical entries, but never replace them.
    const historical = actual.filter((part) =>
      entries.some((old) => old.split('\n')[0] === part.split('\n')[0]),
    );
    expect(historical).toEqual(
      entries.toSorted((a, b) => b.slice(3, 13).localeCompare(a.slice(3, 13))),
    );
    expect(new Set(historical.map((part) => part.split('\n')[0])).size).toBe(
      392,
    );
  });

  it('orders dates descending and equal dates by filename, retaining subsections and references', () => {
    const dir = fixture();
    const first =
      '## 2026-11-24 — Full title (004 §5; 005 §6) — Refs #669\n\nBody.\n\n### Detail\n\nMore.\n\n';
    const second =
      '## 2026-11-24 — Another title\n\nBody without references.\n\n';
    const old = '## 2026-01-01 — Earlier\n\nOld.\n';
    entry(dir, 'z.md', first);
    entry(dir, 'a.md', second);
    entry(dir, '0.md', old);
    expect(run(dir, '--assemble').stdout).toBe(
      '# Spec Changelog\n\n' + second + first + old,
    );
    expect(run(dir).status).toBe(0);
  });

  it.each([
    ['missing date', '## A title\n\nBody.\n', 'date'],
    ['malformed date', '## 2026-1-02 — Title\n', 'date'],
    ['impossible date', '## 2026-02-30 — Title\n', 'date'],
    ['empty title', '## 2026-11-24 —   \n', 'title'],
    ['missing title', '## 2026-11-24\n', 'title'],
    [
      'second entry',
      '## 2026-11-24 — Title\n\n## 2026-11-23 — Other\n',
      'heading',
    ],
  ])('rejects %s', (_name, contents, diagnostic) => {
    const dir = fixture();
    entry(dir, 'invalid.md', contents);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain('invalid.md');
  });

  it('rejects the same date and title in different files', () => {
    const dir = fixture();
    entry(dir, 'one.md', '## 2026-11-24 — Same\n\nOne body.\n');
    entry(dir, 'two.md', '## 2026-11-24 — Same\n\nDifferent body.\n');
    expect(run(dir).status).toBe(1);
    expect(run(dir).stderr).toContain('duplicate');
  });

  it('rejects a legacy dated heading in the index', () => {
    const dir = fixture();
    writeFileSync(
      path.join(dir, 'docs/specs/spec-changelog.md'),
      '# Spec Changelog\n\n## 2026-11-24 — Legacy\n',
    );
    expect(run(dir).status).toBe(1);
    expect(run(dir).stderr).toContain('spec-changelog.md');
  });

  it('merges two branches that each add exactly one file and validates their result', () => {
    const dir = fixture();
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-b', 'base');
    git('config', 'user.name', 'Mike North');
    git('config', 'user.email', 'michael.l.north@gmail.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initialize spec index');
    git('checkout', '-b', 'first');
    entry(
      dir,
      'first.md',
      '## 2026-11-24 — First change (004 §5) — Refs #1\n\nFirst.\n\n',
    );
    git('add', '.');
    git('commit', '-m', 'Record first change');
    expect(git('diff', '--name-only', 'base')).toBe(
      'docs/specs/changelog/first.md\n',
    );
    git('checkout', '-b', 'second', 'base');
    entry(dir, 'second.md', '## 2026-11-24 — Second change\n\nSecond.\n');
    git('add', '.');
    git('commit', '-m', 'Record second change');
    expect(git('diff', '--name-only', 'base')).toBe(
      'docs/specs/changelog/second.md\n',
    );
    git('checkout', 'first');
    git('merge', '--no-edit', 'second');
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(run(dir).status).toBe(0);
    expect(datedEntries(run(dir, '--assemble').stdout)).toHaveLength(2);
  });
});
