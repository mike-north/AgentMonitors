/**
 * Theme-aware, reduced-motion-safe SVG/CSS diagrams for the landing page.
 *
 * Ported from the design handoff (project/js/diagrams.jsx):
 *   - MonitorUnit: the annotated MONITOR.md unit (frontmatter = what to watch;
 *     body = what it means + what to do).
 *   - Anatomy: world → ear canal (transport) → the monitor (hearing) → agent.
 *   - FanOut: many agents, many tangled polling loops → many agents, one watch.
 */
import type { JSX } from 'react';
import { Api, Arrow, Cli, Doc, FileGlyph, Repo } from './icons';

/** The unit: an annotated MONITOR.md. */
export function MonitorUnit(): JSX.Element {
  return (
    <div className="mon">
      <div
        className="code"
        role="img"
        aria-label="An annotated MONITOR.md file. Frontmatter declares what to watch; the body says what it means and what to do."
      >
        <div className="code-bar">
          <span className="dotrow">
            <i />
            <i />
            <i />
          </span>
          <span className="fn">MONITOR.md</span>
        </div>
        <pre>
          <span className="punc">{'---'}</span>
          {'\n'}
          <span>
            <span className="k">name:</span>
            <span className="s"> Watch the upstream API spec</span>
            {'\n'}
          </span>
          <span className="anno-front">
            <span>
              <span className="k">watch:</span>
              {'\n'}
            </span>
            <span>
              {'  '}
              <span className="k">type:</span>
              <span className="s"> url</span>
              {'\n'}
            </span>
            <span>
              {'  '}
              <span className="k">url:</span>
              <span className="s"> https://api.vendor.com/openapi.json</span>
              {'\n'}
            </span>
          </span>
          <span className="punc">{'---'}</span>
          {'\n'}
          {'\n'}
          <span className="anno-body">
            <span className="body-line">{'The upstream API spec changed. Diff it against my client in\n'}</span>
            <span className="body-line">{'src/api/ and flag any breaking changes I need to handle.\n'}</span>
          </span>
        </pre>
      </div>
      <div className="mon-notes">
        <div className="mon-note front">
          <span className="bk">▟</span>
          <div>
            <h4>
              The <code>watch:</code> block — what to watch
            </h4>
            <p>
              The facts the runtime handles for you: where to look and how to tell when it changed. Deterministic, off to the
              side. You never write a polling loop.
            </p>
          </div>
        </div>
        <div className="mon-note bodyn">
          <span className="bk">¶</span>
          <div>
            <h4>The body — what it means &amp; what to do</h4>
            <p>
              Your judgment, in plain language, run by the agent only when the watch actually fires. One small file declares
              both halves.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The anatomy: where a signal travels. */
export function Anatomy(): JSX.Element {
  return (
    <div className="anatomy">
      <div className="anatomy-cap">
        <span className="idx">·</span> The anatomy — where a signal travels &nbsp;
        <span className="muted">(channels are the ear canal; monitors are the hearing)</span>
      </div>
      <div className="flow">
        <div className="fl world">
          <span className="fl-h">The world</span>
          <span className="fl-t">Things that change</span>
          <div className="chips">
            <span>
              <FileGlyph /> file
            </span>
            <span>
              <Api /> API
            </span>
            <span>
              <Repo /> repo
            </span>
            <span>
              <Doc /> doc
            </span>
            <span>
              <Cli /> CLI
            </span>
          </div>
        </div>
        <div className="fl-arrow" aria-hidden="true">
          <Arrow />
        </div>
        <div className="fl canal">
          <span className="fl-h">Transport</span>
          <span className="fl-t">The ear canal</span>
          <span className="fl-d">
            channel · hook · CLI — carries a signal in. Content-agnostic; only moves what already pushes.
          </span>
        </div>
        <div className="fl-arrow live" aria-hidden="true">
          <Arrow />
        </div>
        <div className="fl hearing">
          <span className="fl-h">The monitor</span>
          <span className="fl-t">The hearing</span>
          <span className="fl-d">Detects the change and knows what to listen for. Reaches the unpushable; filters the noise.</span>
        </div>
        <div className="fl-arrow live" aria-hidden="true">
          <Arrow />
        </div>
        <div className="fl agent">
          <span className="fl-h">The receiver</span>
          <span className="fl-t">Your agent</span>
          <span className="fl-d">Told the moment it matters — pre-digested, at a turn boundary. Acts with its own tools.</span>
        </div>
      </div>
    </div>
  );
}

/** Fan-out: many loops → one watch. */
export function FanOut(): JSX.Element {
  const agents = [0, 1, 2, 3, 4, 5, 6, 7] as const;
  const y = (i: number): number => 22 + i * 22;
  return (
    <div className="fanout-wrap">
      <div className="fanout-cols">
        <figure className="fanout-card">
          <figcaption>
            <span className="bad">Before</span> 20 agents, 20 polling loops
          </figcaption>
          <svg viewBox="0 0 320 200" className="fanout" role="img" aria-label="Before: twenty agents each running their own polling loop into one API, tangled and fighting rate limits and locks.">
            {agents.map((i) => (
              <path key={i} className="fan-line tangle" d={`M30 ${String(y(i))} C 150 ${String(y(i))}, 180 100, 286 100`} />
            ))}
            {agents.map((i) => (
              <circle key={`n${String(i)}`} className="fan-node" cx="22" cy={y(i)} r="6" />
            ))}
            <circle cx="292" cy="100" r="15" fill="none" stroke="var(--red)" strokeWidth="1.5" opacity="0.7" />
            <circle cx="292" cy="100" r="9" className="fan-node" />
            <text x="292" y="103" textAnchor="middle" fontSize="9" fontFamily="var(--mono)" fill="var(--text-dim)">
              API
            </text>
            <text x="292" y="135" textAnchor="middle" fontSize="8.5" fontFamily="var(--mono)" fill="var(--red)">
              rate limits · locks
            </text>
          </svg>
        </figure>
        <figure className="fanout-card good">
          <figcaption>
            <span className="ok">After</span> 20 agents, one watch
          </figcaption>
          <svg viewBox="0 0 320 200" className="fanout" role="img" aria-label="After: twenty agents drawing from one monitor with a single clean ingress to the API.">
            {agents.map((i) => (
              <path key={i} className="fan-clean" d={`M30 ${String(y(i))} C 90 ${String(y(i))}, 120 100, 150 100`} opacity="0.85" />
            ))}
            {agents.map((i) => (
              <circle key={`n${String(i)}`} className="fan-node" cx="22" cy={y(i)} r="6" />
            ))}
            <rect x="150" y="84" width="32" height="32" rx="8" className="fan-hub" />
            <path
              d="M160 96 a4 4 0 0 1 8 0 c0 2-1.5 2.8-2.2 3.6-.5.5-.6 1-.6 1.6a1.4 1.4 0 0 1-2.8 0"
              stroke="var(--signal)"
              strokeWidth="1.3"
              fill="none"
            />
            <path className="fan-clean" d="M182 100 H 286" />
            <circle cx="292" cy="100" r="9" className="fan-node" />
            <text x="292" y="103" textAnchor="middle" fontSize="9" fontFamily="var(--mono)" fill="var(--text-dim)">
              API
            </text>
            <text x="166" y="135" textAnchor="middle" fontSize="8.5" fontFamily="var(--mono)" fill="var(--signal)">
              one ingress
            </text>
          </svg>
        </figure>
      </div>
    </div>
  );
}
