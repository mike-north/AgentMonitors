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
 * The finished before/after "you are the loop" illustration. A themed inline
 * SVG: a weary person trapped in a repeating ask-loop (left) versus a monitor
 * catching a change in the world and handing it to an already-acting agent
 * (right). Styles live in `landing.css` under the `.ba` selectors and reuse the
 * site's existing :root tokens; animations respect `prefers-reduced-motion`.
 */
export function YouAreTheLoop(): JSX.Element {
  return (
    <div
      className="ba"
      role="img"
      aria-label="Before and after. Left: a weary person trapped in a loop, repeatedly asking their agent — any new comments, did CI pass, again, again. Right: the loop is gone — a monitor catches a change out in the world and hands it to the agent, which is already acting, while the person sits at ease."
    >
      <svg viewBox="0 0 560 360" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden={true} focusable={false}>
        <defs>
          <marker id="ba-red" markerWidth="9" markerHeight="9" refX="5" refY="4" orient="auto">
            <path d="M1 1 L6 4 L1 7" fill="none" stroke="var(--red)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
          </marker>
          <marker id="ba-amber" markerWidth="10" markerHeight="10" refX="5.5" refY="4" orient="auto">
            <path d="M1 1 L6 4 L1 7" fill="none" stroke="var(--signal)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="ba-amber-soft" markerWidth="10" markerHeight="10" refX="5.5" refY="4" orient="auto">
            <path d="M1 1 L6 4 L1 7" fill="none" stroke="var(--signal)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
          </marker>
        </defs>

        {/* LEFT — the loop */}
        <path className="loop" markerEnd="url(#ba-red)" d="M84 214 C 96 168, 120 130, 158 114" />
        <path className="loop" markerEnd="url(#ba-red)" d="M196 118 C 170 166, 132 198, 88 224" />

        <text className="ask ask-fade" x="8" y="208" fillOpacity="0.82" style={{ animationDelay: '0s' }}>
          any new comments?
        </text>
        <text className="ask ask-fade" x="14" y="184" fillOpacity="0.6" style={{ animationDelay: '.5s' }}>
          did CI pass?
        </text>
        <text className="ask ask-fade" x="22" y="160" fillOpacity="0.42" style={{ animationDelay: '1s' }}>
          again?
        </text>
        <text className="ask ask-fade" x="34" y="138" fillOpacity="0.26" style={{ animationDelay: '1.5s' }}>
          again?
        </text>

        <g>
          <rect x="156" y="52" width="64" height="64" rx="15" className="node" />
          <circle cx="176" cy="80" r="3.1" className="node-face" style={{ fill: 'currentColor' }} />
          <circle cx="200" cy="80" r="3.1" className="node-face" style={{ fill: 'currentColor' }} />
          <path d="M178 97 h20" className="node-face" />
        </g>
        <g transform="translate(70 224) rotate(8)" className="fig fig-weary">
          <circle cx="0" cy="0" r="12" />
          <path d="M0 12 v9" />
          <path d="M-21 44 a21 21 0 0 1 42 0" />
        </g>

        {/* SEAM */}
        <line className="seam" x1="280" y1="64" x2="280" y2="300" />
        <path className="seam-arrow" d="M274 178 l9 8 l-9 8 z" />

        {/* RIGHT — loop gone */}
        <g className="world">
          <path d="M500 50 h22 l8 8 v30 a2 2 0 0 1 -2 2 h-28 a2 2 0 0 1 -2 -2 v-36 a2 2 0 0 1 2 -2 z" />
          <path d="M522 50 v8 h8" />
        </g>
        <circle className="glow" cx="530" cy="48" r="5" />

        <g className="ear" transform="translate(446 98) scale(1.18)">
          <path d="M2 10 a9 9 0 0 1 18 0 c0 5-3.6 7-5.4 8.8-1.6 1.6-2 3-2 4.6a4 4 0 0 1-8 0" />
          <path d="M7 10 a4 4 0 0 1 8 0" />
          <path d="M22 5 a10 10 0 0 1 0 17" opacity="0.5" />
        </g>

        <g>
          <rect x="340" y="136" width="64" height="64" rx="15" className="node node-lit" />
          <circle cx="360" cy="164" r="3.1" className="node-face node-lit-face" style={{ fill: 'currentColor' }} />
          <circle cx="384" cy="164" r="3.1" className="node-face node-lit-face" style={{ fill: 'currentColor' }} />
          <path d="M361 181 q11 7 22 0" className="node-face node-lit-face" />
          <g className="spark" transform="translate(402 138)">
            <path d="M0 -7 V7 M-7 0 H7" />
            <path d="M-5 -5 L5 5 M5 -5 L-5 5" opacity="0.6" />
          </g>
        </g>
        <g transform="translate(336 252) rotate(-5)" className="fig fig-calm">
          <circle cx="0" cy="0" r="12" />
          <path d="M0 12 v9" />
          <path d="M-21 44 a21 21 0 0 1 42 0" />
        </g>

        <path className="flow" markerEnd="url(#ba-amber)" d="M512 90 C 496 102, 484 106, 470 112 C 446 124, 424 140, 406 156" />
        <path className="flow-told" markerEnd="url(#ba-amber-soft)" d="M360 202 C 352 216, 347 224, 341 231" />
        <circle
          className="flow-dot"
          r="3.4"
          style={{ offsetPath: "path('M512 90 C 496 102, 484 106, 470 112 C 446 124, 424 140, 406 156')", offsetDistance: '100%' }}
        />
      </svg>
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
 *
 * Commands verified against @agentmonitors/cli@0.6.0 (issue #135):
 * - `npm install -g @agentmonitors/cli` — install step
 * - `agentmonitors init <name> --type api-poll` — real form; `api-poll` is a
 *   valid `--type` choice (file-fingerprint, api-poll, command-poll, schedule,
 *   incoming-changes); default is file-fingerprint when omitted
 * - `agentmonitors daemon run` — real subcommand (`daemon` has: once, run, status, stop)
 * Keep these in sync with apps/website/src/pages/index.md quickstart section
 * and apps/website/src/pages/docs/getting-started.md.
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
