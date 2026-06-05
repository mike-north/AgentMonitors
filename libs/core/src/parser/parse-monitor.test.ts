import { describe, expect, it } from 'vitest';
import { parseMonitor } from './parse-monitor.js';

const yaml = String.raw;

const validContent = yaml`---
name: GitHub PR review monitor
source: api-poll
urgency: normal
event-kind: notification
scope:
  url: "https://api.github.com/repos/my-org/my-repo/pulls"
  interval: 5m
notify:
  strategy: debounce
  settle-for: 5m
tags: [github, review]
---

When new PR reviews are detected, summarize them and add a todo item to address feedback.
`;

const minimalContent = yaml`---
name: File watcher
source: file-fingerprint
urgency: high
event-kind: mutation
scope:
  globs:
    - "**/*.ts"
---

Check the modified files and report changes.
`;

describe('parseMonitor', () => {
  it('parses valid full monitor', () => {
    const result = parseMonitor(
      validContent,
      '/monitors/github-pr-review/MONITOR.md',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.monitor.id).toBe('github-pr-review');
    expect(result.monitor.frontmatter.name).toBe('GitHub PR review monitor');
    expect(result.monitor.frontmatter.source).toBe('api-poll');
    expect(result.monitor.frontmatter.urgency).toBe('normal');
    expect(result.monitor.frontmatter['event-kind']).toBe('notification');
    expect(result.monitor.frontmatter.notify).toEqual({
      strategy: 'debounce',
      'settle-for': '5m',
    });
    expect(result.monitor.frontmatter.tags).toEqual(['github', 'review']);
    expect(result.monitor.instructions).toBe(
      'When new PR reviews are detected, summarize them and add a todo item to address feedback.',
    );
    expect(result.monitor.filePath).toBe(
      '/monitors/github-pr-review/MONITOR.md',
    );
  });

  it('parses minimal valid monitor', () => {
    const result = parseMonitor(
      minimalContent,
      '/monitors/file-watcher/MONITOR.md',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.monitor.id).toBe('file-watcher');
    expect(result.monitor.frontmatter.urgency).toBe('high');
    expect(result.monitor.frontmatter['event-kind']).toBe('mutation');
    expect(result.monitor.frontmatter.notify).toBeUndefined();
    expect(result.monitor.frontmatter.tags).toBeUndefined();
  });

  it('derives id from parent folder name', () => {
    const result = parseMonitor(
      minimalContent,
      '/home/user/.claude/monitors/my-custom-monitor/MONITOR.md',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.monitor.id).toBe('my-custom-monitor');
  });

  it('returns body content as instructions (trimmed)', () => {
    const content = yaml`---
name: Test
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs: ["*.ts"]
---

  Some instructions with leading whitespace.

  And trailing whitespace.

`;
    const result = parseMonitor(content, '/monitors/test/MONITOR.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.monitor.instructions).toBe(
      'Some instructions with leading whitespace.\n\n  And trailing whitespace.',
    );
  });

  it('returns error for missing frontmatter', () => {
    const content = 'Just some markdown without frontmatter.';
    const result = parseMonitor(content, '/monitors/no-fm/MONITOR.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `name` is now optional; the error surfaces the other missing required fields
    expect(result.error).toContain('source');
  });

  it('returns error for invalid frontmatter values', () => {
    const content = yaml`---
name: Test
source: file-fingerprint
urgency: critical
event-kind: mutation
scope:
  globs: ["*.ts"]
---

Instructions.
`;
    const result = parseMonitor(content, '/monitors/bad/MONITOR.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('urgency');
  });

  it('returns error for missing required scope', () => {
    const content = yaml`---
name: Test
source: file-fingerprint
urgency: normal
event-kind: mutation
---

Instructions.
`;
    const result = parseMonitor(content, '/monitors/no-scope/MONITOR.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('scope');
  });

  it('returns error for invalid notify config', () => {
    const content = yaml`---
name: Test
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs: ["*.ts"]
notify:
  strategy: debounce
---

Instructions.
`;
    const result = parseMonitor(content, '/monitors/bad-notify/MONITOR.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('settle-for');
  });

  it('preserves filePath in error result', () => {
    const result = parseMonitor('---\n---\n', '/some/path/MONITOR.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.filePath).toBe('/some/path/MONITOR.md');
  });
});

const FRONTMATTER = yaml`---
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs:
    - 'src/**/*.ts'
---
Body instructions.
`;

it('derives the id from the filename for a flat monitor file', () => {
  const outcome = parseMonitor(
    FRONTMATTER,
    '/repo/.claude/monitors/watch-src.md',
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('watch-src');
});

it('derives the id from the parent directory for a folder monitor (MONITOR.md)', () => {
  const outcome = parseMonitor(
    FRONTMATTER,
    '/repo/.claude/monitors/pr-watch/MONITOR.md',
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('pr-watch');
});

it('derives the id correctly for an extension-less flat path', () => {
  const outcome = parseMonitor(FRONTMATTER, '/x/.claude/monitors/noext');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('noext');
});

it('derives the id correctly for a multi-dot flat filename', () => {
  const outcome = parseMonitor(FRONTMATTER, '/x/.claude/monitors/foo.bar.md');
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('foo.bar');
});

it('rejects a path whose basename is .md (empty derived id)', () => {
  const outcome = parseMonitor(FRONTMATTER, '/x/.claude/monitors/.md');
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(outcome.error).toContain('Could not derive a monitor id');
});

it('rejects a dotfile path like .foo.md (non-empty but dot-prefixed id)', () => {
  const outcome = parseMonitor(FRONTMATTER, '/x/.claude/monitors/.foo.md');
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(outcome.error).toContain('Could not derive a monitor id');
});

it('sets displayName to the frontmatter name when present', () => {
  const outcome = parseMonitor(
    validContent,
    '/monitors/github-pr-review/MONITOR.md',
  );
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.monitor.displayName).toBe('GitHub PR review monitor');
});

it('sets displayName to the id when name is omitted', () => {
  const outcome = parseMonitor(
    FRONTMATTER,
    '/repo/.claude/monitors/watch-src.md',
  );
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.monitor.frontmatter.name).toBeUndefined();
  expect(outcome.monitor.displayName).toBe(outcome.monitor.id);
});
