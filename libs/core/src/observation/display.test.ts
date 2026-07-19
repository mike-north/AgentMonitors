/**
 * Tests for {@link displayObjectKey} — the bounded rendering of a source
 * `objectKey` into human-facing observation text (003 §2.8, issue #449).
 *
 * Expected values are written from the rule itself ("unchanged at or below the
 * 60-character bound; otherwise a 59-character prefix plus `…`"), not captured
 * from the implementation's output.
 *
 * @see ../../../../docs/specs/003-source-plugins.md §2.8
 */
import { describe, expect, it } from 'vitest';
import { displayObjectKey } from './display.js';

describe('displayObjectKey (issue #449)', () => {
  it('returns a short key unchanged', () => {
    expect(displayObjectKey('ofocus today --json')).toBe('ofocus today --json');
  });

  it('returns a key exactly at the bound unchanged', () => {
    const exact = 'a'.repeat(60);
    expect(displayObjectKey(exact)).toBe(exact);
    expect(displayObjectKey(exact)).not.toContain('…');
  });

  it('truncates one character past the bound to a 59-char prefix plus an ellipsis', () => {
    const over = 'b'.repeat(61);
    expect(displayObjectKey(over)).toBe(`${'b'.repeat(59)}…`);
    expect(displayObjectKey(over)).toHaveLength(60);
  });

  it('bounds the reported jq-program argv, keeping its readable head', () => {
    const argv =
      'env -u GITHUB_TOKEN gh pr list --author @me --state all --limit 12 ' +
      "--json number,title,state --jq '[.[] | {number, state}]'";
    const rendered = displayObjectKey(argv);
    expect(rendered).toHaveLength(60);
    expect(rendered.startsWith('env -u GITHUB_TOKEN gh pr list')).toBe(true);
    expect(rendered).not.toContain('--jq');
  });

  it('returns an empty key unchanged (no spurious ellipsis)', () => {
    expect(displayObjectKey('')).toBe('');
  });
});
