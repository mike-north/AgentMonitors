/**
 * Markdoc node-schema overrides.
 *
 * `@markdoc/next.js` auto-discovers this file (alongside `./tags`) the same way it does
 * `markdoc/tags.ts` — see its loader's `importAtRuntime('nodes')` call.
 *
 * The `heading` override is the documented Markdoc anchor-link recipe
 * (https://markdoc.dev/docs/nodes#example-headings-with-anchor-links): it slugifies each
 * heading's rendered text into an `id` attribute. Without it, Markdoc renders headings with
 * no `id` at all, so every same-page fragment link used throughout the docs
 * (`[Urgency](#urgency)`, `[Project not enabled](#project-not-enabled)`, etc.) 404s at the
 * anchor even though the page itself resolves — exactly the class of defect
 * `pnpm --filter @agentmonitors/website run check:links` (`--check-fragments`) is meant to catch.
 *
 * @see https://markdoc.dev/docs/nodes#example-headings-with-anchor-links
 */
import { nodes as defaultNodes, Tag } from '@markdoc/markdoc';
import type { Config, Node, RenderableTreeNode } from '@markdoc/markdoc';

export function generateId(
  children: RenderableTreeNode[],
  attributes: Record<string, unknown>,
): string {
  if (typeof attributes['id'] === 'string') {
    return attributes['id'];
  }

  return children
    .filter((child): child is string => typeof child === 'string')
    .join(' ')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

export const heading = {
  ...defaultNodes.heading,
  transform(node: Node, config: Config) {
    const attributes = node.transformAttributes(config);
    const children = node.transformChildren(config);
    const id = generateId(children, attributes);

    return new Tag(`h${String(node.attributes['level'])}`, { ...attributes, id }, children);
  },
};

const nodes = { heading };

export default nodes;
