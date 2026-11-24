/**
 * Tests for the channel's transcript confirmation reader (006 §4.5.2, issue
 * #535): read-only, only bytes appended since the push, bounded, and any
 * failure is "unconfirmed".
 *
 * @see ../../../docs/specs/006-agent-integration.md §4.5.2
 */
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptConfirmer } from './channel-push-confirmation.js';

const SESSION = 'b7f2c1d0-0000-4000-8000-000000000001';
const ID = '00112233445566778899aabbccddeeff';

let dir: string;
let transcript: string;

function enqueueLine(deliveryId: string): string {
  return `${JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-11-23T17:05:48.034Z',
    sessionId: SESSION,
    content: `<channel source="plugin:agentmonitors:agentmonitors" delivery_id="${deliveryId}">\nx\n</channel>`,
  })}\n`;
}

/** A confirmer on a virtual clock: each poll's sleep advances time. */
function confirmer(
  options: {
    boundMs?: number;
    maxScanBytes?: number;
    onPoll?: (poll: number) => void;
    resolveTranscriptPath?: () => string | undefined;
  } = {},
) {
  let clock = 0;
  let polls = 0;
  return createTranscriptConfirmer(SESSION, {
    resolveTranscriptPath: options.resolveTranscriptPath ?? (() => transcript),
    boundMs: options.boundMs ?? 1_000,
    pollMs: 100,
    ...(options.maxScanBytes !== undefined
      ? { maxScanBytes: options.maxScanBytes }
      : {}),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      polls += 1;
      options.onPoll?.(polls);
      return Promise.resolve();
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'agentmon-confirm-'));
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, '{"type":"user"}\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createTranscriptConfirmer (006 §4.5.2)', () => {
  it('confirms once the host appends the enqueue entry for this push', async () => {
    const pending = confirmer({
      onPoll: (poll) => {
        if (poll === 2) appendFileSync(transcript, enqueueLine(ID));
      },
    }).begin(ID);
    expect(pending).toBeDefined();
    await expect(pending?.wait()).resolves.toBe(true);
  });

  it('does not confirm from entries written before the push began', async () => {
    appendFileSync(transcript, enqueueLine(ID));
    const pending = confirmer().begin(ID);
    await expect(pending?.wait()).resolves.toBe(false);
  });

  it('times out unconfirmed when the host writes nothing (no listener)', async () => {
    const pending = confirmer({ boundMs: 500 }).begin(ID);
    await expect(pending?.wait()).resolves.toBe(false);
  });

  it('does not confirm an enqueue for a different push', async () => {
    const pending = confirmer({
      onPoll: () => {
        appendFileSync(
          transcript,
          enqueueLine('ffeeddccbbaa99887766554433221100'),
        );
      },
    }).begin(ID);
    await expect(pending?.wait()).resolves.toBe(false);
  });

  it('confirms an entry the host writes in two halves', async () => {
    const line = enqueueLine(ID);
    const pending = confirmer({
      onPoll: (poll) => {
        if (poll === 1) appendFileSync(transcript, line.slice(0, 30));
        if (poll === 2) appendFileSync(transcript, line.slice(30));
      },
    }).begin(ID);
    await expect(pending?.wait()).resolves.toBe(true);
  });

  it('has no evidence source when no transcript path is recorded', () => {
    expect(
      confirmer({ resolveTranscriptPath: () => undefined }).begin(ID),
    ).toBe(undefined);
  });

  it('has no evidence source when the transcript file does not exist', () => {
    unlinkSync(transcript);
    expect(confirmer().begin(ID)).toBeUndefined();
  });

  it('never follows a symlink to the transcript', () => {
    const real = path.join(dir, 'real.jsonl');
    writeFileSync(real, '');
    unlinkSync(transcript);
    symlinkSync(real, transcript);
    expect(confirmer().begin(ID)).toBeUndefined();
  });

  it('is unconfirmed if the transcript is truncated after the push', async () => {
    appendFileSync(transcript, 'x'.repeat(5_000) + '\n');
    const pending = confirmer({
      onPoll: () => {
        truncateSync(transcript, 0);
        appendFileSync(transcript, enqueueLine(ID));
      },
    }).begin(ID);
    // The re-written file is shorter than where the push began; a shorter
    // file is a different file, so it proves nothing about this push.
    await expect(pending?.wait()).resolves.toBe(false);
    expect(statSync(transcript).size).toBeLessThan(5_000);
  });

  // Review of PR #660 (issue #535): a FIFO renamed over the transcript after
  // the push began made the blocking open wait for a writer that never comes,
  // wedging the whole channel process. It must read as unconfirmed instead.
  //
  // A blocked synchronous open also stalls this test's own worker, so vitest's
  // timeout could never fire. A writer that opens the FIFO after 3 seconds
  // bounds the regression instead: a blocking open then ends late, and the
  // elapsed-time assertion fails rather than the test hanging.
  it.skipIf(process.platform === 'win32')(
    'is unconfirmed, without blocking, if a FIFO replaces the transcript while waiting',
    async () => {
      let writer: ChildProcess | undefined;
      const pending = confirmer({
        onPoll: (poll) => {
          if (poll === 1) {
            unlinkSync(transcript);
            execFileSync('mkfifo', [transcript]);
            writer = spawn('sh', ['-c', 'sleep 3; exec 3>"$0"', transcript], {
              stdio: 'ignore',
            });
          }
        },
      }).begin(ID);
      const started = Date.now();
      try {
        await expect(pending?.wait()).resolves.toBe(false);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        writer?.kill('SIGKILL');
      }
    },
  );

  it('is unconfirmed if the transcript disappears while waiting', async () => {
    const pending = confirmer({
      onPoll: () => {
        rmSync(transcript, { force: true });
      },
    }).begin(ID);
    await expect(pending?.wait()).resolves.toBe(false);
  });

  it('stops at the scan cap rather than reading without limit', async () => {
    const pending = confirmer({
      maxScanBytes: 1_024,
      boundMs: 60_000,
      onPoll: (poll) => {
        if (poll === 1) appendFileSync(transcript, `${'y'.repeat(2_000)}\n`);
        if (poll === 2) appendFileSync(transcript, enqueueLine(ID));
      },
    }).begin(ID);
    await expect(pending?.wait()).resolves.toBe(false);
  });
});
