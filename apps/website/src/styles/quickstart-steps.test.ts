/**
 * Regression guard for the quickstart step list layout in `landing.css`.
 *
 * The quickstart steps (`{% prose %}` markdown in index.md) render each step as
 * a bare `<li>` whose children are inline content straight from markdown — text
 * runs, `<strong>`, and inline `<code>`. If `.quick ol li` is made a grid or
 * flex container, CSS "blockifies" every one of those direct children into a
 * separate, auto-placed item: the inline `<code>` pills become full-width
 * blocks and the text fragments scatter into the narrow counter track, wrapping
 * the prose to one word per line (observed live on agentmonitors.io). The fix
 * keeps the `<li>` a normal block and floats the counter badge into a gutter
 * with absolute positioning, so the content flows as ordinary wrapped text.
 *
 * These assertions parse the real `landing.css`, so reintroducing a grid/flex
 * display on the step `<li>` fails here rather than silently shipping the
 * collapse again.
 *
 * @see https://drafts.csswg.org/css-display/#blockify
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const LANDING_CSS = join(stylesDir, 'landing.css');

/**
 * Extract the declaration body of the rule whose selector is exactly
 * `selector` (not a descendant like `${selector} code` or a pseudo like
 * `${selector}::before`). Returns the text between the matching braces.
 */
function ruleBody(css: string, selector: string): string {
  // Match the selector only when the next non-space character is `{` — so
  // `.quick ol li {` matches but `.quick ol li::before {` / `.quick ol li b {`
  // do not.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = re.exec(css);
  if (!match) {
    throw new Error(`No CSS rule found for exact selector "${selector}"`);
  }
  return match[2];
}

/** Read the `display` value declared in a rule body, or undefined if none. */
function displayValue(body: string): string | undefined {
  const m = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body);
  return m ? m[1].trim() : undefined;
}

describe('.quick ol li layout', () => {
  const css = readFileSync(LANDING_CSS, 'utf8');

  it('is not a grid or flex container (which would blockify markdown children)', () => {
    // undefined (no `display` → default block) is fine; only grid/flex are the
    // bug, so coerce an absent declaration to a benign empty string.
    const display = displayValue(ruleBody(css, '.quick ol li')) ?? '';
    expect(display).not.toMatch(/\b(grid|flex|inline-grid|inline-flex)\b/);
  });

  it('positions the counter badge out of flow so content flows as text', () => {
    const liBody = ruleBody(css, '.quick ol li');
    const beforeBody = ruleBody(css, '.quick ol li::before');
    // The badge is absolutely positioned; the li reserves a gutter for it.
    expect(beforeBody).toMatch(/position\s*:\s*absolute/);
    expect(liBody).toMatch(/position\s*:\s*relative/);
    expect(liBody).toMatch(/padding-left\s*:/);
  });

  it('keeps inline code as an inline pill, not a block', () => {
    // The code pill rule must not force a block display (belt-and-suspenders:
    // even if the li regressed to grid, an explicit inline here would help).
    const codeDisplay = displayValue(ruleBody(css, '.quick ol li code')) ?? '';
    expect(codeDisplay).not.toMatch(/\bblock\b/);
  });
});
