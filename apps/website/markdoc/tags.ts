/**
 * Markdoc custom-tag registry for the landing page.
 *
 * `@markdoc/next.js` discovers this `markdoc/` directory automatically (the
 * loader imports `./markdoc/{config,tags,nodes,functions}` at build time). Each
 * tag's `render` field is the actual React component — the next.js runtime
 * derives a PascalCase display name and wires the component into the renderer.
 *
 * The interactive / animated pieces (the listening hub, the diagrams) and the
 * dark engineer-warm "chrome" live in React components under
 * `src/components/landing/`. Prose stays in the Markdoc body (the page is
 * authored in `src/pages/index.md`), so the raw `.md` source remains the single
 * source of truth for humans and agents alike.
 *
 * @see https://markdoc.dev/docs/tags
 */
import type { ComponentType } from 'react';
import type { SchemaAttribute } from '@markdoc/markdoc';

import { Hero } from '../src/components/landing/Hero';
import { Anatomy, FanOut, MonitorUnit } from '../src/components/landing/diagrams';
import {
  Callout,
  Door,
  Doors,
  Footer,
  HostNote,
  Nav,
  OneLiner,
  Pillar,
  Pillars,
  PositioningBeat,
  PrePost,
  PrePostCard,
  Prose,
  QuickGrid,
  QuickstartTerminal,
  Section,
  Sig,
  Step,
  Steps,
  TwoCol,
  YouAreTheLoop,
} from '../src/components/landing/sections';

/**
 * A Markdoc tag schema as consumed by `@markdoc/next.js`. `render` is the React
 * component itself (the next.js runtime substitutes the PascalCase display name
 * the base Markdoc `Schema` type expects). The component's own prop type is
 * preserved via the generic, so no prop-shape casts are needed.
 */
interface TagSchema<P> {
  readonly render: ComponentType<P>;
  readonly selfClosing?: boolean;
  readonly inline?: boolean;
  readonly attributes?: Record<string, SchemaAttribute>;
}

/** Identity helper that infers and preserves each component's prop type. */
function defineTag<P>(schema: TagSchema<P>): TagSchema<P> {
  return schema;
}

const requiredString: SchemaAttribute = { type: String, required: true };
const optionalString: SchemaAttribute = { type: String, required: false };

const tags = {
  nav: defineTag({ render: Nav, selfClosing: true }),

  hero: defineTag({
    render: Hero,
    selfClosing: true,
    attributes: {
      eyebrow: requiredString,
      headline: requiredString,
      subhead: requiredString,
      primaryCta: requiredString,
      primaryHref: requiredString,
      secondaryCta: requiredString,
      secondaryHref: requiredString,
    },
  }),

  positioningBeat: defineTag({ render: PositioningBeat }),

  sig: defineTag({ render: Sig, inline: true }),

  section: defineTag({
    render: Section,
    attributes: {
      index: optionalString,
      kicker: optionalString,
      id: optionalString,
      variant: optionalString,
    },
  }),

  twoCol: defineTag({ render: TwoCol }),
  prose: defineTag({ render: Prose }),
  youAreTheLoop: defineTag({ render: YouAreTheLoop, selfClosing: true }),

  prepost: defineTag({ render: PrePost }),
  prepostCard: defineTag({
    render: PrePostCard,
    attributes: { kind: { type: String, required: true, matches: ['before', 'after'] } },
  }),
  oneliner: defineTag({ render: OneLiner }),

  monitorUnit: defineTag({ render: MonitorUnit, selfClosing: true }),

  steps: defineTag({ render: Steps }),
  step: defineTag({
    render: Step,
    attributes: {
      n: requiredString,
      heading: requiredString,
      last: { type: Boolean, required: false },
    },
  }),

  anatomy: defineTag({ render: Anatomy, selfClosing: true }),

  pillars: defineTag({ render: Pillars }),
  pillar: defineTag({
    render: Pillar,
    attributes: {
      n: requiredString,
      heading: requiredString,
      span: { type: String, required: true, matches: ['lead', 'span4', 'span6', 'span8'] },
    },
  }),
  fanout: defineTag({ render: FanOut, selfClosing: true }),

  callout: defineTag({
    render: Callout,
    attributes: { question: requiredString },
  }),
  hostNote: defineTag({ render: HostNote }),

  quickGrid: defineTag({ render: QuickGrid }),
  quickstartTerminal: defineTag({ render: QuickstartTerminal, selfClosing: true }),

  doors: defineTag({ render: Doors }),
  door: defineTag({
    render: Door,
    attributes: { heading: requiredString, href: requiredString },
  }),

  siteFooter: defineTag({ render: Footer, selfClosing: true }),
};

export default tags;
