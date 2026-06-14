/**
 * The listening hub — the hero centerpiece.
 *
 * A typographic stack of "listening for…" outcome lines beside an ear glyph
 * with concentric amber sound-wave arcs. The choreography is deliberately CALM:
 * signals resolve to amber one at a time, gently and staggered (resolve →
 * settle → next), and the ear/agent stays steady — receiving clean,
 * already-resolved pulses, never piling up. The agent is the RECEIVER: pulses
 * travel TO the ear; polling (the invisible daemon) is never depicted.
 *
 * Honors prefers-reduced-motion: one line is rendered pre-resolved with the ear
 * lit and no motion.
 *
 * Ported from the design handoff (project/js/hero.jsx → ListeningHub).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, JSX, SVGProps } from 'react';
import { Cli, Doc, IconEarWaves, Layers, Repo, Shield, Spark } from './icons';

interface HubRow {
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly txt: string;
  readonly src: string;
}

/**
 * Developer / chief-of-staff outcomes (one agent, many signal types — this
 * carries pillar #1, breadth-at-scale). Per the brief, NO personal-life
 * outcomes here. Order and copy match the design-agent prompt's hero spec.
 */
const HUB_ROWS: readonly HubRow[] = [
  { Icon: Repo, txt: 'a code review on your PR', src: 'github' },
  { Icon: Shield, txt: 'a new security advisory', src: 'osv' },
  { Icon: Layers, txt: 'a new release of a dependency', src: 'npm' },
  { Icon: Cli, txt: 'CI to finish', src: 'actions' },
  { Icon: Spark, txt: 'a failed deploy', src: 'vercel' },
  { Icon: Doc, txt: 'the product spec to change', src: 'gdoc' },
  { Icon: Repo, txt: 'the eng spec to change on main', src: 'git' },
];

/** The CI row is pre-resolved in the reduced-motion still fallback. */
const REDUCED_MOTION_ROW = 3;

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ListeningHub(): JSX.Element {
  // Resolve reduced-motion AFTER mount so SSR/first-paint markup is deterministic
  // (server can't read matchMedia); we then collapse to the still fallback if set.
  const [reduced, setReduced] = useState(false);
  const [active, setActive] = useState(-1);
  const [lit, setLit] = useState(false);
  const [wire, setWire] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const earRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!prefersReducedMotion()) return;
    setReduced(true);
    setActive(REDUCED_MOTION_ROW);
    setLit(true);
  }, []);

  // Calm staggered loop: one signal resolves gently, settles, then the next.
  useEffect(() => {
    if (reduced) return;
    let index = 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const step = (): void => {
      if (!alive) return;
      setActive(index);
      setLit(true); // one signal resolves
      timer = setTimeout(() => {
        if (!alive) return;
        setLit(false);
        setActive(-1); // settle — ear stays steady
        timer = setTimeout(() => {
          index = (index + 1) % HUB_ROWS.length;
          step();
        }, 760);
      }, 1850);
    };

    timer = setTimeout(step, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reduced]);

  // Draw the connector from the resolving row to the ear using real, measured
  // geometry. matchMedia / getBoundingClientRect are browser-only and run only
  // in this client effect.
  useLayoutEffect(() => {
    const compute = (): void => {
      const body = bodyRef.current;
      const ear = earRef.current;
      const row = rowRefs.current[active];
      if (active < 0 || !body || !ear || !row) {
        setWire(null);
        return;
      }
      const b = body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const e = ear.getBoundingClientRect();
      const sx = r.right - b.left - 8;
      const sy = r.top + r.height / 2 - b.top;
      const ex = e.left + e.width / 2 - b.left;
      const ey = e.top + e.height / 2 - b.top;
      const mx = sx + (ex - sx) * 0.58;
      setWire(`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex - 1} ${ey}`);
    };

    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [active]);

  return (
    <div className="hub">
      <div className="hub-head">
        <span className="lbl">~/monitors · 7 active</span>
        <span className="live">
          <i />
          listening
        </span>
      </div>
      <div className="hub-body" ref={bodyRef}>
        <svg className="hub-wire" aria-hidden="true">
          {wire !== null && (
            <g>
              <path className="wire-path" d={wire} key={`p${String(active)}`} />
              {!reduced && (
                <circle className="wire-dot" r="3">
                  <animateMotion
                    dur="0.8s"
                    path={wire}
                    fill="freeze"
                    calcMode="spline"
                    keyTimes="0;1"
                    keySplines="0.4 0 0.2 1"
                  />
                </circle>
              )}
            </g>
          )}
        </svg>
        <div className="feed">
          {HUB_ROWS.map((row, idx) => {
            const { Icon } = row;
            const on = active === idx;
            return (
              <div
                className={on ? 'row on' : 'row'}
                key={`${row.src}-${row.txt}`}
                ref={(el) => {
                  rowRefs.current[idx] = el;
                }}
              >
                <span className="gl">
                  <Icon />
                </span>
                <span className="txt">
                  <span className="listening-txt">
                    {row.txt}
                    <span className="ell">…</span>
                  </span>
                </span>
                <span className="src">{row.src}</span>
              </div>
            );
          })}
        </div>
        <div className={lit ? 'ear lit' : 'ear'} ref={earRef} aria-hidden="true">
          <span className="halo" />
          {lit && <span className="ring" key={active} />}
          <IconEarWaves className="glyph" />
        </div>
      </div>
    </div>
  );
}
