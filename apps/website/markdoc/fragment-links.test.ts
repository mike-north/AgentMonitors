/**
 * Regression test for issue #274: Markdoc renders headings with no `id` attribute unless a
 * node override supplies one (see `markdoc/nodes.ts`). Before that override existed, every
 * same-page fragment link in the docs — e.g. `[Urgency](#urgency)` in
 * `src/pages/docs/authoring-monitors.md` — pointed at an anchor that did not exist in the
 * rendered HTML, and nothing in the test suite caught it (the link-check CI job added in the
 * same PR catches it too, but only against a built-and-served site; this runs at unit-test
 * speed against every page's real content).
 *
 * This test parses each doc page with the real production Markdoc config (the same
 * `heading` node override used at build time) and asserts every same-page `#fragment` link
 * found in that page's raw source resolves to a heading id the transform actually produced.
 *
 * @see https://markdoc.dev/docs/nodes#example-headings-with-anchor-links
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import Markdoc, { Tag } from '@markdoc/markdoc';
import type { RenderableTreeNode } from '@markdoc/markdoc';
import { describe, expect, it } from 'vitest';

import { heading } from './nodes';

const pagesDir = path.resolve(import.meta.dirname, '../src/pages');

function findMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return findMarkdownFiles(entryPath);
    }
    return entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

function collectHeadingIds(node: RenderableTreeNode, ids: Set<string>): void {
  if (!(node instanceof Tag)) {
    return;
  }
  const id = node.attributes['id'];
  if (typeof id === 'string' && id.length > 0) {
    ids.add(id);
  }
  for (const child of node.children) {
    collectHeadingIds(child, ids);
  }
}

/** Same-page fragment links only — `[text](#slug)`, not `[text](/path#slug)`. */
function findSameFragmentLinks(source: string): string[] {
  return [...source.matchAll(/]\(#([a-z0-9-]+)\)/g)].map((match) => match[1] ?? '');
}

const markdownFiles = findMarkdownFiles(pagesDir);

/** One row per (file, referenced #fragment) so a failure names the exact broken anchor. */
const fragmentLinkCases = markdownFiles.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return findSameFragmentLinks(source).map(
    (link) => [path.relative(pagesDir, file), link, source] as const,
  );
});

describe('doc page fragment links (issue #274 regression)', () => {
  it('found at least one markdown page to check (sanity check on the test itself)', () => {
    expect(markdownFiles.length).toBeGreaterThan(0);
  });

  it.each(fragmentLinkCases)('%s: #%s resolves to a real heading id', (_relativePath, link, source) => {
    const tokens = new Markdoc.Tokenizer({ allowComments: true }).tokenize(source);
    const ast = Markdoc.parse(tokens);
    const rendered = Markdoc.transform(ast, { nodes: { heading } });

    const ids = new Set<string>();
    collectHeadingIds(rendered, ids);

    expect(ids).toContain(link);
  });

  it('rejects a fragment link with no matching heading (negative case)', () => {
    const source = '## Real Heading\n\nSee [broken](#does-not-exist).';
    const links = findSameFragmentLinks(source);

    const tokens = new Markdoc.Tokenizer({ allowComments: true }).tokenize(source);
    const ast = Markdoc.parse(tokens);
    const rendered = Markdoc.transform(ast, { nodes: { heading } });

    const ids = new Set<string>();
    collectHeadingIds(rendered, ids);

    expect(links).toEqual(['does-not-exist']);
    expect(ids.has('does-not-exist')).toBe(false);
  });
});
