/**
 * Shared SVG icons + brand mark for the landing page.
 *
 * Ported faithfully from the design handoff (project/js/icons.jsx). Each icon
 * is a strict-TS function component that forwards arbitrary SVG props (so the
 * caller controls sizing/aria via className) and is decorative by default.
 */
import type { JSX, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function Mark(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true" {...props}>
      <circle cx="7.5" cy="14" r="2.4" fill="var(--signal)" />
      <path d="M12.5 8 A 7.5 7.5 0 0 1 12.5 20" stroke="var(--text-dim)" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17.5 5 A 12 12 0 0 1 17.5 23" stroke="var(--signal)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function IconEye(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M2 12s3.6-6.6 10-6.6S22 12 22 12s-3.6 6.6-10 6.6S2 12 2 12Z" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconHand(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M9.2 11V5.4a1.4 1.4 0 0 1 2.8 0V10m0-.4V4.1a1.4 1.4 0 0 1 2.8 0V10m0-.2V5.6a1.4 1.4 0 0 1 2.8 0V13M6.4 11.4V8.6a1.4 1.4 0 0 1 2.8 0V12M6.4 11.4 5 13c-.5.6-.4 1.4 0 2l2.6 3.5C9 20.3 10.4 21 13 21c3.8 0 6.4-2.9 6.4-6.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconEar(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M6.5 9a5.5 5.5 0 0 1 11 0c0 3-2.2 4.2-3.3 5.4-1 1-1.2 1.8-1.2 2.8a2.5 2.5 0 0 1-5 0M9.6 9a2.4 2.4 0 0 1 4.8 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconEarWaves(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M5 9.5a5.5 5.5 0 0 1 11 0c0 3-2.2 4.2-3.3 5.4-1 1-1.2 1.8-1.2 2.8a2.5 2.5 0 0 1-5 0M8.1 9.5a2.4 2.4 0 0 1 4.8 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.6 6.8a6.5 6.5 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
      <path d="M19.6 4.6a10 10 0 0 1 0 14.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.3" />
    </svg>
  );
}

export function Arrow(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M5 12h14m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowUpRight(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M7 17 17 7m0 0H8m9 0v9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Check(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Cross(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function GitHub(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.93.85.09-.66.35-1.12.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.72 0 0 .84-.27 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.42.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

export function FileGlyph(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M13 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Api(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M9 8 5 12l4 4m6-8 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Repo(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 8.4v7.2M8.4 7.2c5 .6 6.6 1.4 6.6 4.4v1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Doc(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Cli(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="m7 10 2.5 2L7 14m5 .5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shield(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 3 5 6v5c0 4.2 2.8 7.6 7 9 4.2-1.4 7-4.8 7-9V6l-7-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Layers(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m3 13 9 5 9-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Target(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

export function Clock(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spark(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 3v5m0 8v5m9-9h-5M8 12H3m13.5-6.5L13 9m-2 6-3.5 3.5m11 0L15 15M9 9 5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Forward(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M4 12h12m0 0-4-4m4 4-4 4M18 6v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
