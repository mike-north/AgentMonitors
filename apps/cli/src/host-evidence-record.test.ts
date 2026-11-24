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
