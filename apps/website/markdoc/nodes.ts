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

  return renderableText(children)
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

/**
 * Recursively extract the text of a renderable tree. Headings routinely contain
 * inline tags — most commonly inline code like `### \`doctor\`` — whose text
 * lives in nested Tag children; slugifying only top-level strings would give
 * those headings empty or truncated ids and break fragment links.
 */
function renderableText(children: RenderableTreeNode[]): string {
  return children
    .map((child): string => {
      if (typeof child === 'string') return child;
      if (typeof child === 'number') return String(child);
      if (
        child !== null &&
        typeof child === 'object' &&
        'children' in child &&
        Array.isArray(child.children)
      ) {
        return renderableText(child.children);
      }
      return '';
    })
    .join(' ');
}

export const heading = {
  ...defaultNodes.heading,
  transform(node: Node, config: Config) {
    const attributes = node.transformAttributes(config);
    const children = node.transformChildren(config);
    const id = generateId(children, attributes);

    // Omit the attribute entirely when no id could be derived — rendering
    // id="" would be invalid as an anchor target anyway.
    return new Tag(
      `h${String(node.attributes['level'])}`,
      id === '' ? attributes : { ...attributes, id },
      children,
    );
  },
};

const nodes = { heading };

export default nodes;
