/**
 * Tests for the hook-recorded transcript location the channel confirms pushes
 * against (006 §4.5.2, issue #535). The record holds a path only.
 *
 * @see ../../../docs/specs/006-agent-integration.md §4.5.2
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostEvidenceDir,
  readHostTranscriptPath,
  recordHostTranscriptPath,
} from './host-evidence-record.js';

const SESSION = 'b7f2c1d0-0000-4000-8000-000000000002';
let dataRoot: string;
let previous: string | undefined;

/**
 * Record at a simulated time: the record's clock AND, when this call really
 * wrote the file, its mtime are set to `at`, as if the write happened then.
 */
function recordAt(
  hostSessionId: string,
  transcriptPath: string,
  at: number,
): void {
  recordHostTranscriptPath(hostSessionId, transcriptPath, new Date(at));
  for (const name of readdirSync(hostEvidenceDir())) {
    if (!name.includes(hostSessionId)) continue;
    const file = path.join(hostEvidenceDir(), name);
    if (readFileSync(file, 'utf-8').includes(new Date(at).toISOString())) {
      utimesSync(file, new Date(at), new Date(at));
    }
  }
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), 'agentmon-evidence-'));
  previous = process.env['XDG_DATA_HOME'];
  process.env['XDG_DATA_HOME'] = dataRoot;
});

afterEach(() => {
  if (previous === undefined) delete process.env['XDG_DATA_HOME'];
  else process.env['XDG_DATA_HOME'] = previous;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('host transcript record', () => {
  it('round-trips the transcript path a hook reported for its session', () => {
    const transcript = `/home/u/.claude/projects/-w/${SESSION}.jsonl`;
    recordHostTranscriptPath(SESSION, transcript);
    expect(readHostTranscriptPath(SESSION)).toBe(transcript);
  });

  it('a later report replaces the earlier one (e.g. after /clear moved the transcript)', () => {
    recordHostTranscriptPath(SESSION, `/a/${SESSION}.jsonl`);
    recordHostTranscriptPath(SESSION, `/b/${SESSION}.jsonl`);
    expect(readHostTranscriptPath(SESSION)).toBe(`/b/${SESSION}.jsonl`);
  });

  it('ignores a path that is not this session’s own transcript', () => {
    recordHostTranscriptPath(SESSION, '/a/other-session.jsonl');
    recordHostTranscriptPath(SESSION, `relative/${SESSION}.jsonl`);
    recordHostTranscriptPath(SESSION, undefined);
    expect(readHostTranscriptPath(SESSION)).toBeUndefined();
  });

  it('keeps sessions apart', () => {
    recordHostTranscriptPath(SESSION, `/a/${SESSION}.jsonl`);
    expect(readHostTranscriptPath('another-session')).toBeUndefined();
  });

  it('stores the path and a timestamp only', () => {
    recordHostTranscriptPath(
      SESSION,
      `/a/${SESSION}.jsonl`,
      new Date('2026-11-23T17:05:48.034Z'),
    );
    const [name] = readdirSync(hostEvidenceDir());
    const stored = JSON.parse(
      readFileSync(path.join(hostEvidenceDir(), name ?? ''), 'utf-8'),
    ) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'hostSessionId',
      'observedAt',
      'schemaVersion',
      'transcriptPath',
    ]);
  });

  // Review of PR #660 (issue #535): an unchanged report skipped the write, so
  // a record aged from its FIRST report and a session still prompting after
  // 14 days lost it as soon as another session's write ran the reaper.
  it('a session that keeps reporting the same path keeps its record past the retention age', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = new Date('2026-11-01T00:00:00.000Z').getTime();
    const own = `/a/${SESSION}.jsonl`;
    const other = 'b7f2c1d0-0000-4000-8000-0000000000ff';
    recordAt(SESSION, own, t0);
    recordAt(SESSION, own, t0 + 13 * DAY);
    recordAt(other, `/a/${other}.jsonl`, t0 + 15 * DAY);
    expect(readHostTranscriptPath(SESSION)).toBe(own);
  });

  it('an unchanged report within the hour does not rewrite the record', () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z').getTime();
    const own = `/a/${SESSION}.jsonl`;
    recordHostTranscriptPath(SESSION, own, new Date(t0));
    recordHostTranscriptPath(SESSION, own, new Date(t0 + 10 * 60 * 1000));
    const [name] = readdirSync(hostEvidenceDir());
    const stored = JSON.parse(
      readFileSync(path.join(hostEvidenceDir(), name ?? ''), 'utf-8'),
    ) as { observedAt: string };
    expect(stored.observedAt).toBe(new Date(t0).toISOString());
  });

  it('reaps a record whose session stopped reporting more than 14 days ago', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = new Date('2026-11-01T00:00:00.000Z').getTime();
    const other = 'b7f2c1d0-0000-4000-8000-0000000000ff';
    recordAt(SESSION, `/a/${SESSION}.jsonl`, t0);
    recordAt(other, `/a/${other}.jsonl`, t0 + 15 * DAY);
    expect(readHostTranscriptPath(SESSION)).toBeUndefined();
    expect(readHostTranscriptPath(other)).toBe(`/a/${other}.jsonl`);
  });

  it('treats a corrupt or tampered record as no record', () => {
    recordHostTranscriptPath(SESSION, `/a/${SESSION}.jsonl`);
    const [name] = readdirSync(hostEvidenceDir());
    const file = path.join(hostEvidenceDir(), name ?? '');
    writeFileSync(file, '{not json');
    expect(readHostTranscriptPath(SESSION)).toBeUndefined();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        hostSessionId: SESSION,
        transcriptPath: '/a/someone-else.jsonl',
        observedAt: '2026-11-23T17:05:48.034Z',
      }),
    );
    expect(readHostTranscriptPath(SESSION)).toBeUndefined();
  });

  it('never throws when the data root is unwritable', () => {
    mkdirSync(path.join(dataRoot, 'agentmonitors'), { recursive: true });
    writeFileSync(
      path.join(dataRoot, 'agentmonitors', 'host-evidence'),
      'file',
    );
    expect(() => {
      recordHostTranscriptPath(SESSION, `/a/${SESSION}.jsonl`);
    }).not.toThrow();
    expect(readHostTranscriptPath(SESSION)).toBeUndefined();
  });
});
