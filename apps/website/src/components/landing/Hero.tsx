/**
 * Hero section chrome — the eyebrow, headline, subhead, CTAs, and the live
 * listening hub centerpiece.
 *
 * Copy (headline/subhead/eyebrow/CTA labels) is passed in as attributes from
 * the Markdoc source so the raw `.md` still carries the real words for agents
 * fetching the page as markdown. Ported from project/js/hero.jsx → Hero.
 */
import type { JSX } from 'react';
import { Arrow } from './icons';
import { ListeningHub } from './ListeningHub';

interface HeroProps {
  readonly eyebrow: string;
  readonly headline: string;
  readonly subhead: string;
  readonly primaryCta: string;
  readonly primaryHref: string;
  readonly secondaryCta: string;
  readonly secondaryHref: string;
}

export function Hero({
  eyebrow,
  headline,
  subhead,
  primaryCta,
  primaryHref,
  secondaryCta,
  secondaryHref,
}: HeroProps): JSX.Element {
  return (
    <section className="hero" id="top">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" />
            {eyebrow}
          </span>
          <h1 className="h-hero">{headline}</h1>
          <p className="lede">{subhead}</p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href={primaryHref}>
              {primaryCta} <Arrow />
            </a>
            <a className="btn btn-ghost" href={secondaryHref}>
              {secondaryCta}
            </a>
          </div>
        </div>
        <div className="hero-hub">
          <ListeningHub />
        </div>
      </div>
    </section>
  );
}
