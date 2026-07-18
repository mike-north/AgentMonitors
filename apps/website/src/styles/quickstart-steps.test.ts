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
 * These assertions parse the real `landing.css` with postcss (not a hand-rolled
 * regex), so they see every rule whose selector list includes `.quick ol li` —
 * including ones nested inside `@media` — and evaluate the effective (last
 * declaration wins, case-insensitive) `display` value the way a real browser
 * would. That closes the holes a regex-based scan can't see: a second matching
 * rule reintroducing `display: grid` inside a media query, or a selector list
 * like `.quick ol li, .other { ... }`.
 *
 * @see https://drafts.csswg.org/css-display/#blockify
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import type { Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const LANDING_CSS = join(stylesDir, 'landing.css');

/** `display` values that establish a grid or flex formatting context. */
const GRID_OR_FLEX_DISPLAY_TOKENS = new Set([
  'grid',
  'inline-grid',
  'flex',
  'inline-flex',
]);

/**
 * Does this `display` declaration value establish a grid or flex container?
 * Matches single-keyword forms (`grid`, `inline-flex`, ...) and multi-keyword
 * forms (`inline grid`, `block flex`, ...) by checking whole whitespace-
 * separated tokens, case-insensitively — never a substring match, so values
 * like `inline-block` are correctly left alone.
 */
function isGridOrFlexDisplay(value: string): boolean {
  const tokens = value.toLowerCase().trim().split(/\s+/);
  return tokens.some((token) => GRID_OR_FLEX_DISPLAY_TOKENS.has(token));
}

/** Does this rule's selector list include `selector` as one of its members? */
function ruleMatchesSelector(rule: Rule, selector: string): boolean {
  return rule.selectors.some((s) => s.trim() === selector);
}

/**
 * The effective `display` value for every rule (anywhere in the stylesheet,
 * including inside `@media`/other at-rules) whose selector list contains
 * `selector` — CSS applies the LAST valid declaration in source order when a
 * property is repeated within a rule, so only the last `display` per rule is
 * kept. Absent a `display` declaration, a rule contributes `undefined`.
 */
function effectiveDisplayValues(
  css: string,
  selector: string,
): (string | undefined)[] {
  const root = postcss.parse(css);
  const values: (string | undefined)[] = [];
  root.walkRules((rule) => {
    if (!ruleMatchesSelector(rule, selector)) {
      return;
    }
    let lastDisplay: string | undefined;
    rule.walkDecls('display', (decl) => {
      lastDisplay = decl.value;
    });
    values.push(lastDisplay);
  });
  return values;
}

/**
 * Find the (first) rule whose selector list contains `selector`. Throws a
 * clear, named error if none exists — a missing selector is a loud failure,
 * not a silently-skipped assertion.
 */
function findRule(css: string, selector: string): Rule {
  const root = postcss.parse(css);
  let found: Rule | undefined;
  root.walkRules((rule) => {
    if (!found && ruleMatchesSelector(rule, selector)) {
      found = rule;
    }
  });
  if (!found) {
    throw new Error(`No CSS rule found for exact selector "${selector}"`);
  }
  return found;
}

/** Does this rule declare `prop` (case-insensitively) with a value matching `valuePattern`? */
function ruleHasDeclaration(
  rule: Rule,
  prop: string,
  valuePattern: RegExp,
): boolean {
  let matched = false;
  rule.walkDecls(new RegExp(`^${prop}$`, 'i'), (decl) => {
    if (valuePattern.test(decl.value.toLowerCase())) {
      matched = true;
    }
  });
  return matched;
}

describe('.quick ol li layout', () => {
  const css = readFileSync(LANDING_CSS, 'utf8');

  it('is never a grid or flex container anywhere in the stylesheet (which would blockify markdown children)', () => {
    // undefined (no `display` declared) is fine; only grid/flex forms are the
    // bug. This walks every rule in the file — including ones nested in
    // `@media` — so a duplicate rule reintroducing `display: grid` later in
    // the cascade can't hide from the guard.
    const displays = effectiveDisplayValues(css, '.quick ol li');
    expect(displays.length).toBeGreaterThan(0);
    for (const display of displays) {
      if (display === undefined) {
        continue;
      }
      expect(isGridOrFlexDisplay(display)).toBe(false);
    }
  });

  it('positions the counter badge out of flow so content flows as text', () => {
    const liRule = findRule(css, '.quick ol li');
    const beforeRule = findRule(css, '.quick ol li::before');

    // The badge is absolutely positioned; the li reserves a gutter for it via
    // either `padding-left` or the logical `padding-inline-start`.
    expect(ruleHasDeclaration(beforeRule, 'position', /^absolute$/)).toBe(true);
    expect(ruleHasDeclaration(liRule, 'position', /^relative$/)).toBe(true);
    expect(
      ruleHasDeclaration(liRule, 'padding-left', /./) ||
        ruleHasDeclaration(liRule, 'padding-inline-start', /./),
    ).toBe(true);
  });
});
