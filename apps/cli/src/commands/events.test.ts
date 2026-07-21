/**
 * Unit tests for `singleLineSafe`, the control-safe rendering `events list
 * --format text` applies to untrusted, source- or author-controlled fields
 * (monitor `name`, source `title`/`summary`) before interpolating them into a
 * "one record per line" text row.
 *
 * Regression for issue #449 review (PR #455): a raw CR/LF in an authored
 * monitor `name` or a source's `title`/`summary` forged a second output row,
 * and a raw ESC sequence reached the terminal unescaped, because the field
 * was interpolated verbatim.
 *
 * Every control/line-separator character below is constructed via
 * `String.fromCharCode` from its numeric code point (never a literal byte or
 * a `\u` escape typed directly into a string literal), so this test file
 * carries no raw control byte and cannot be silently corrupted by an editor
 * or tool that mangles literal control characters.
 *
 * @see ../../../../docs/specs/005-cli-reference.md
 */
import { describe, expect, it } from 'vitest';
import { singleLineSafe } from './events.js';

const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const C1_CSI = String.fromCharCode(0x9b);
const TAB = String.fromCharCode(0x09);

describe('singleLineSafe', () => {
  it('leaves ordinary text untouched', () => {
    expect(singleLineSafe('Watch files')).toBe('Watch files');
  });

  it('collapses a raw LF to a single space, keeping the result one line', () => {
    const input = `evil title${LF}EVENT_ID  fake-monitor  high  unread  forged row`;
    const output = singleLineSafe(input);
    expect(output.split(LF)).toHaveLength(1);
    expect(output).toBe(
      'evil title EVENT_ID  fake-monitor  high  unread  forged row',
    );
  });

  it('collapses a raw CRLF to a single space', () => {
    expect(singleLineSafe(`a${CR}${LF}b`)).toBe('a b');
  });

  it('collapses the Unicode LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029)', () => {
    expect(singleLineSafe(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)).toBe(
      'a b c',
    );
  });

  it('escapes a raw ESC (C0) control character to a visible \\uXXXX form instead of passing it through', () => {
    const input = `a${ESC}[31mRED${ESC}[0mb`;
    const output = singleLineSafe(input);
    expect(output).not.toContain(ESC);
    expect(output).toBe('a\\u001b[31mRED\\u001b[0mb');
  });

  it('escapes DEL (U+007F)', () => {
    expect(singleLineSafe(`a${DEL}b`)).toBe('a\\u007fb');
  });

  it('escapes a C1 control character (e.g. U+009B CSI)', () => {
    expect(singleLineSafe(`a${C1_CSI}b`)).toBe('a\\u009bb');
  });

  it('preserves a plain tab (not a line-forging or rendering hazard)', () => {
    expect(singleLineSafe(`a${TAB}b`)).toBe(`a${TAB}b`);
  });

  it('handles a string combining line-break and other control characters', () => {
    const input = `line1${CR}${LF}line2${ESC}ESC`;
    expect(singleLineSafe(input)).toBe('line1 line2\\u001bESC');
  });
});
