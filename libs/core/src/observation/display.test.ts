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

  // Reported in review of #449: a code-unit cut split an astral code point and
  // emitted a lone high surrogate into durably persisted, re-serialized text.
  it('never splits an astral code point at the boundary', () => {
    const straddling = `${'a'.repeat(58)}😀x`;
    const rendered = displayObjectKey(straddling);

    // The emoji occupies code units 58-59, so the 59-unit budget would have cut
    // it in half. It is dropped whole instead.
    expect(rendered).toBe(`${'a'.repeat(58)}…`);
    expect(rendered.length).toBeLessThanOrEqual(60);
    // No unpaired surrogate survives: re-encoding must round-trip losslessly.
    for (const unit of rendered) {
      const code = unit.charCodeAt(0);
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
    expect(Buffer.from(rendered, 'utf8').toString('utf8')).toBe(rendered);
  });

  it('keeps a multi-code-point grapheme cluster whole (flag, ZWJ sequence)', () => {
    // 🇺🇸 is two regional indicators (4 code units); cutting between them would
    // render as a lone 🇺. 👩‍💻 is a ZWJ sequence that would degrade to a bare 👩.
    for (const cluster of ['🇺🇸', '👩‍💻']) {
      const rendered = displayObjectKey(`${'b'.repeat(57)}${cluster}tail`);
      expect(rendered.length).toBeLessThanOrEqual(60);
      // Either the whole cluster is present or none of it — never a fragment.
      const kept = rendered.slice(57, -1);
      expect(kept === cluster || kept === '').toBe(true);
    }
  });

  it('emits an emoji-only key as a bounded, well-formed prefix', () => {
    const rendered = displayObjectKey('😀'.repeat(40));
    expect(rendered.length).toBeLessThanOrEqual(60);
    expect(rendered.endsWith('…')).toBe(true);
    // 29 whole emoji (58 code units) + '…' — never 29.5.
    expect(rendered).toBe(`${'😀'.repeat(29)}…`);
  });
});
