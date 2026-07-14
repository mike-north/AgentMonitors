/**
 * Tests for the `heading` node override in `markdoc/nodes.ts`.
 *
 * Regression coverage for: Markdoc renders headings with no `id` attribute by default, so
 * every same-page fragment link in the docs (`[Urgency](#urgency)`, etc.) silently 404s at the
 * anchor. `pnpm --filter @agentmonitors/website run check:links --check-fragments` (issue #274)
 * is what surfaced this. See `markdoc/fragment-links.test.ts` for the integration-level check
 * across the real doc content; this file covers the slug-generation unit directly.
 *
 * @see https://markdoc.dev/docs/nodes#example-headings-with-anchor-links
 */
import { describe, expect, it } from 'vitest';
import Markdoc, { Tag } from '@markdoc/markdoc';

import { generateId, heading } from './nodes';

describe('generateId', () => {
  it('slugifies plain heading text', () => {
    expect(generateId(['Enable and verify delivery'], {})).toBe('enable-and-verify-delivery');
  });

  it('lowercases and hyphenates multi-word headings', () => {
    expect(generateId(['Notify strategies'], {})).toBe('notify-strategies');
  });

  it('strips punctuation that is not alphanumeric, space, or hyphen', () => {
    expect(generateId(['`file-fingerprint`'], {})).toBe('file-fingerprint');
  });

  it('joins multiple inline-text children with a single space', () => {
    expect(generateId(['Watch an ', 'upstream branch'], {})).toBe('watch-an-upstream-branch');
  });

  it('prefers an explicit id attribute over the derived slug', () => {
    expect(generateId(['Some Heading'], { id: 'custom-id' })).toBe('custom-id');
  });

  it('includes nested inline-tag text (e.g. inline code, bold) when slugifying', () => {
    // Headings like "### `file-fingerprint`" put their text inside a Tag
    // child; slugifying only top-level strings would yield an empty id and
    // break every fragment link targeting such headings.
    const codeChild = new Markdoc.Tag('code', {}, ['file-fingerprint']);
    expect(generateId([codeChild], {})).toBe('file-fingerprint');
    const boldChild = new Markdoc.Tag('strong', {}, ['bold']);
    expect(generateId(['Plain ', boldChild, 'text'], {})).toBe(
      'plain-bold-text',
    );
  });
});

describe('heading node transform', () => {
  it('renders an h-level tag carrying the slugified id', () => {
    const doc = Markdoc.parse('## Project not enabled');
    // The document root transforms into a single `article` Tag; the heading is its first child.
    const rendered = Markdoc.transform(doc, { nodes: { heading } });

    expect(rendered).toMatchObject({
      children: [{ name: 'h2', attributes: { id: 'project-not-enabled' } }],
    });
  });

  it('does not attach an id when the heading is empty (negative/edge case)', () => {
    const doc = Markdoc.parse('##');
    const rendered = Markdoc.transform(doc, { nodes: { heading } });

    const renderedChildren = (rendered as Tag).children;
    const headingTag = renderedChildren[0] as Tag;
    expect(headingTag.name).toBe('h2');
    // The attribute is omitted entirely — id="" would be an invalid anchor.
    expect('id' in headingTag.attributes).toBe(false);
  });
});
