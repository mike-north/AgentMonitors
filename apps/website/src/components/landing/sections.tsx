/**
 * Structural section "chrome" for the landing page. These wrap markdown
 * children (the actual prose) so the raw `.md` source stays the single source
 * of truth for humans and agents alike — the copy lives in the markdown body,
 * these components only supply the dark, engineer-warm layout.
 *
 * Ported from the design handoff (project/js/sections.jsx + hero.jsx).
 */
import type { JSX, ReactNode } from 'react';
import { Arrow, ArrowUpRight, GitHub, IconEar, IconEye, IconHand, Mark } from './icons';

/* ---------- nav ---------- */

interface NavLink {
  readonly label: string;
  readonly href: string;
}

// Absolute hrefs so the nav works identically from the landing page and the
// docs pages (the in-page anchors only exist on "/").
const NAV_LINKS: readonly NavLink[] = [
  { label: 'The problem', href: '/#problem' },
  { label: 'How it works', href: '/#how' },
  { label: 'Quickstart', href: '/#quickstart' },
  { label: 'Why it holds up', href: '/#why' },
  { label: 'Docs', href: '/docs/getting-started' },
];

const GITHUB_URL = 'https://github.com/mike-north/AgentMonitors';

export function Nav(): JSX.Element {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <a className="brand" href="/">
          <Mark />
          <b>Agent Monitors</b>
        </a>
        <div className="nav-links">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>
        <div className="nav-actions">
          <a className="icon-btn" href={GITHUB_URL} aria-label="GitHub repository" title="GitHub" rel="noopener noreferrer" target="_blank">
            <GitHub />
          </a>
          <a className="btn btn-primary" href="/#quickstart">
            Get started <Arrow />
          </a>
        </div>
      </div>
    </nav>
  );
}

/** Inline amber "signal" emphasis span. */
export function Sig({ children }: { readonly children: ReactNode }): JSX.Element {
  return <span className="sig">{children}</span>;
}

/* ---------- generic section ---------- */

interface SectionProps {
  /** Two-digit index shown in the kicker, e.g. "02". */
  readonly index?: string;
  /** Kicker label, e.g. "the problem". */
  readonly kicker?: string;
  /** Section id for in-page anchors. */
  readonly id?: string;
  /** Extra class on the <section> (e.g. "quick", "section--tight"). */
  readonly variant?: string;
  readonly children: ReactNode;
}

export function Section({ index, kicker, id, variant, children }: SectionProps): JSX.Element {
  const className = variant ? `section ${variant}` : 'section';
  return (
    <section className={className} id={id}>
      <div className="wrap">
        {kicker !== undefined && (
          <p className="kicker">
            {index !== undefined && <span className="idx">{index} ·</span>} {kicker}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

/* ---------- positioning beat ---------- */

export function PositioningBeat({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <section className="posbeat section--tight">
      <div className="wrap posbeat-inner">
        <div className="triad" aria-hidden="true">
          <span className="t">
            <IconEye /> Eyes <span className="ok">✓</span>
          </span>
          <span className="t">
            <IconHand /> Hands <span className="ok">✓</span>
          </span>
          <span className="t miss">
            <IconEar /> Ears <span>←</span>
          </span>
        </div>
        <div className="line">{children}</div>
      </div>
    </section>
  );
}

/* ---------- problem: two-column prose + visual ---------- */

export function TwoCol({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="two-col" style={{ marginTop: 40 }}>
      {children}
    </div>
  );
}

export function Prose({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="prose">{children}</div>;
}

/**
 * The before/after illustration is an imagery-agent deliverable that does not
 * yet exist. Rather than ship the prototype's dashed placeholder, render a real
 * schematic "you are the loop" card built from CSS/SVG so the section is
 * complete and honest (no fabricated art, no empty placeholder).
 */
export function YouAreTheLoop(): JSX.Element {
  return (
    <div className="loopfig" role="img" aria-label="You, manually re-asking your agent in a repeating loop, versus a monitor catching the change and handing it to the agent.">
      <div className="loopfig-before">
        <span className="loopfig-tag">today</span>
        <div className="loopfig-cycle">
          <span>“any new comments?”</span>
          <span>“…again?”</span>
          <span>“…still nothing?”</span>
        </div>
        <span className="loopfig-you">you are the loop</span>
      </div>
      <div className="loopfig-arrow" aria-hidden="true">
        <Arrow />
      </div>
      <div className="loopfig-after">
        <span className="loopfig-tag sig">with a monitor</span>
        <div className="loopfig-signal">
          <span className="loopfig-fire">◉ heard — the spec changed</span>
          <span className="loopfig-handoff">↳ your agent already has the diff</span>
        </div>
        <span className="loopfig-you sig">you’re free</span>
      </div>
    </div>
  );
}

interface PrePostProps {
  readonly children: ReactNode;
}

export function PrePost({ children }: PrePostProps): JSX.Element {
  return <div className="prepost">{children}</div>;
}

interface PrePostCardProps {
  readonly kind: 'before' | 'after';
  readonly children: ReactNode;
}

export function PrePostCard({ kind, children }: PrePostCardProps): JSX.Element {
  return (
    <div className={`pp ${kind}`}>
      <span className="tag">{kind === 'before' ? 'Before' : 'After'}</span>
      {children}
    </div>
  );
}

export function OneLiner({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="oneliner">{children}</div>;
}

/* ---------- how it works: steps ---------- */

export function Steps({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="steps">{children}</div>;
}

interface StepProps {
  readonly n: string;
  readonly heading: string;
  /** Whether to render the trailing connector arrow (omit on the last step). */
  readonly last?: boolean;
  readonly children: ReactNode;
}

export function Step({ n, heading, last = false, children }: StepProps): JSX.Element {
  return (
    <div className="step">
      <div className="n">{n}</div>
      <h4>{heading}</h4>
      <div className="step-body">{children}</div>
      {!last && (
        <span className="arr" aria-hidden="true">
          <Arrow />
        </span>
      )}
    </div>
  );
}

/* ---------- pillars ---------- */

export function Pillars({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="pillars" style={{ marginTop: 'clamp(36px,5vw,52px)' }}>
      {children}
    </div>
  );
}

type PillarSpan = 'lead' | 'span4' | 'span6' | 'span8';

interface PillarProps {
  readonly n: string;
  readonly heading: string;
  readonly span: PillarSpan;
  readonly children: ReactNode;
}

export function Pillar({ n, heading, span, children }: PillarProps): JSX.Element {
  return (
    <article className={`pillar ${span}`}>
      <span className="pn">{n}</span>
      <h3>{heading}</h3>
      {children}
    </article>
  );
}

/* ---------- channels callout + host note ---------- */

interface CalloutProps {
  readonly question: string;
  readonly children: ReactNode;
}

export function Callout({ question, children }: CalloutProps): JSX.Element {
  return (
    <div className="callout">
      <span className="mk">
        <IconEar />
      </span>
      <div>
        <div className="q">{question}</div>
        <div className="callout-body">{children}</div>
      </div>
    </div>
  );
}

export function HostNote({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="hostnote">
      <span className="b">↳</span>
      <div className="hostnote-body">{children}</div>
    </div>
  );
}

/* ---------- quickstart ---------- */

export function QuickGrid({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="quick-grid">{children}</div>;
}

/**
 * The first-five-minutes terminal mock. Styled with the shared amber "signal"
 * palette so the site's "ears lighting up" echoes the real CLI's signal line.
 * Host-agnostic per the brief (Claude Code, Codex, Cursor).
 */
export function QuickstartTerminal(): JSX.Element {
  return (
    <div
      className="term"
      role="img"
      aria-label="Terminal: installing the agentmonitors CLI, wiring it into your agent, creating a monitor, and a monitor firing later without you asking."
    >
      <pre>
        <span className="pr">$ </span>npm install -g @agentmonitors/cli{'\n'}
        {'\n'}
        <span className="pr">$ </span>agentmonitors init slack-api-specs --type api-poll{'\n'}
        <span className="cmt">✓ created monitors/slack-api-specs/MONITOR.md</span>
        {'\n'}
        {'\n'}
        <span className="pr">$ </span>agentmonitors daemon run{'\n'}
        <span className="cmt">○ agentmonitors · 3 monitors active · watching</span>
        {'\n'}
        {'\n'}
        <span className="cmt"># …later, without you asking</span>
        {'\n'}
        <span className="amb">◉ heard</span> &nbsp;the Slack API spec changed{'\n'}
        {'         '}
        <span className="amb">↳</span> your agent already has the diff{'\n'}
      </pre>
    </div>
  );
}

/* ---------- doors ---------- */

export function Doors({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="doors">{children}</div>;
}

interface DoorProps {
  readonly heading: string;
  readonly href: string;
  readonly children: ReactNode;
}

export function Door({ heading, href, children }: DoorProps): JSX.Element {
  return (
    <a className="door" href={href}>
      <div className="dh">
        <h4>{heading}</h4>
        <ArrowUpRight />
      </div>
      <div className="door-body">{children}</div>
    </a>
  );
}

/* ---------- footer ---------- */

export function Footer(): JSX.Element {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <a className="brand" href="/">
          <Mark />
          <b>Agent Monitors</b>
        </a>
        <div className="meta">
          open-source <span className="sep">·</span> local-first <span className="sep">·</span> agentmonitors.io
        </div>
        <div className="docs-note">
          docs: <a href="/docs/getting-started">HTML</a> &nbsp;·&nbsp;{' '}
          <a href="/docs/getting-started.md">raw .md</a>
        </div>
      </div>
    </footer>
  );
}
