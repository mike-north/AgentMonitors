// Parse tracked roadmap test gaps and detect drift against numbered specs'
// open gap markers (spec 004 §3.0).
//
// A tracked test gap has a stable id `T<n>`. The numbered spec that governs it
// carries the id in a bold marker (`**TEST GAP T1**` or `**PARTIAL GAP T1**`)
// for as long as the obligation is open. The roadmap's "Test gaps" section lists
// the gaps it considers closed as `- **T1** — …` bullets (a bullet containing
// "(open)" is still open). The two must agree: a gap the roadmap calls closed
// must have no marker left in any numbered spec, and every marker must carry an
// id so the pairing cannot be bypassed by an unnumbered marker.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const SPECS_DIR = join(REPO_ROOT, 'docs', 'specs');

const MARKER_RE = /\*\*(?:TEST|PARTIAL) GAP\b([^*]*)\*\*/g;
const MARKER_ID_RE = /^ T(\d+)$/;
const ROADMAP_BULLET_RE = /^- \*\*T(\d+)\*\*/;
const NUMBERED_SPEC_RE = /^\d{3}-.*\.md$/;
// A repo path cited in backticks that names a test file; bare file names
// (no directory) are shorthand for a neighbour and are not resolvable alone.
const CITED_TEST_PATH_RE = /`((?:[\w.-]+\/)+[\w.-]+\.test\.(?:ts|mjs))`/g;

/** Gap markers in one spec's text: `{ id, line }`, with `id` undefined when absent. */
export function findGapMarkers(text) {
  const markers = [];
  text.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(MARKER_RE)) {
      const id = MARKER_ID_RE.exec(match[1])?.[1];
      markers.push({ id: id && `T${id}`, line: index + 1 });
    }
  });
  return markers;
}

/** Tracked ids and their open or closed status in the roadmap's "Test gaps" section. */
export function findRoadmapGaps(roadmapText) {
  const lines = roadmapText.split('\n');
  const start = lines.findIndex((line) => /^## Test gaps\s*$/.test(line));
  if (start === -1) return [];
  const gaps = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const match = ROADMAP_BULLET_RE.exec(line);
    if (match)
      gaps.push({
        id: `T${match[1]}`,
        status: line.includes('(open)') ? 'open' : 'closed',
      });
  }
  return gaps;
}

/** Ids the roadmap's "Test gaps" section claims closed. */
export function findClosedRoadmapGaps(roadmapText) {
  return findRoadmapGaps(roadmapText)
    .filter(({ status }) => status === 'closed')
    .map(({ id }) => id);
}

/** Repo-relative test file paths a spec cites in backticks. */
export function findCitedTestPaths(text) {
  return [...new Set([...text.matchAll(CITED_TEST_PATH_RE)].map((m) => m[1]))];
}

/**
 * Human-readable problems across a set of specs and the roadmap.
 * `specs` maps a spec file name to its text; `pathExists` resolves a cited path.
 */
export function checkSpecGapDrift({ specs, roadmapText, pathExists }) {
  const problems = [];
  const closed = new Set(findClosedRoadmapGaps(roadmapText));
  for (const [name, text] of Object.entries(specs)) {
    for (const { id, line } of findGapMarkers(text)) {
      if (id === undefined) {
        problems.push(
          `${name}:${line} gap marker has no tracked id (expected a bold "TEST GAP T<n>" marker)`,
        );
      } else if (closed.has(id)) {
        problems.push(
          `${name}:${line} carries open gap marker ${id} but roadmap.md lists ${id} as closed`,
        );
      }
    }
    for (const path of findCitedTestPaths(text)) {
      if (!pathExists(path)) {
        problems.push(`${name} cites test file ${path}, which does not exist`);
      }
    }
  }
  return problems;
}

/** Numbered specs and the roadmap as they are on disk. */
export function loadRepoSpecs(specsDir = SPECS_DIR) {
  const specs = {};
  for (const name of readdirSync(specsDir)) {
    if (NUMBERED_SPEC_RE.test(name)) {
      specs[name] = readFileSync(join(specsDir, name), 'utf8');
    }
  }
  return {
    specs,
    roadmapText: readFileSync(join(specsDir, 'roadmap.md'), 'utf8'),
  };
}

let trackedTestFiles;

/**
 * Whether a cited test path resolves. Specs cite either a repo-relative path or
 * one relative to a package's `src` (e.g. `runtime/x.test.ts`), so a path
 * resolves when it exists on disk or is a path suffix of a tracked test file.
 */
export function repoPathExists(path) {
  if (existsSync(join(REPO_ROOT, path))) return true;
  trackedTestFiles ??= execFileSync(
    'git',
    ['ls-files', '*.test.ts', '*.test.mjs'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  return trackedTestFiles.some((file) => file.endsWith(`/${path}`));
}
