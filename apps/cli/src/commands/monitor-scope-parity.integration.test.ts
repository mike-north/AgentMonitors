/**
 * Authoring commands must reject the same source configuration before observing.
 * Real subprocesses preserve the commands' distinct output envelopes; local HTTP
 * and file sentinels make premature network requests and command execution visible.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

/** The built CLI is an input to tests; Nx owns building it before the suite. */
const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');

/** Capture both error channels even when validation deliberately exits nonzero. */
async function run(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_PATH, ...args],
        {
          cwd,
          env: { ...process.env, AGENTMONITORS_DB: ':memory:' },
          timeout: 10_000,
        },
        (error, stdout, stderr) => {
          if (error && (error.killed || typeof error.code !== 'number')) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, exitCode: error?.code ?? 0 });
        },
      );
    },
  );
}

describe('monitor test / validate scope parity', () => {
  let root: string;
  let url: string;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end('{"items":[]}');
  });

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'monitor-scope-parity-'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    url = `http://127.0.0.1:${String(address.port)}/snapshot`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  });

  /** Use exactly one file per tree so validate cannot reject an unrelated sibling. */
  function writeMonitor(id: string, watch: Record<string, unknown>) {
    const dir = path.join(root, id);
    const monitorDir = path.join(dir, 'monitors', id);
    mkdirSync(monitorDir, { recursive: true });
    const file = path.join(monitorDir, 'MONITOR.md');
    writeFileSync(
      file,
      `---\n${stringify({ watch, urgency: 'normal' })}---\nObserve the configured resource.\n`,
    );
    return { dir, file, monitors: path.join(dir, 'monitors') };
  }

  /** A valid argv whose execution has an externally observable filesystem effect. */
  function commandWatch(sentinel: string): Record<string, unknown> {
    return {
      type: 'command-poll',
      command: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], 'observed'); console.log('{}')",
        sentinel,
      ],
    };
  }

  // Expected locations and constraints come from the bundled source schemas and
  // BP3, independently of either command's output. Full diagnostics must also
  // agree across commands and formats, including parent/leaf schema errors.
  const cases = [
    {
      name: 'invalid enum',
      watch: () => ({ type: 'api-poll', url, method: 'DELETE' }),
      details: ['scope/method', '"GET"', '"POST"'],
    },
    {
      name: 'unknown property',
      watch: (sentinel: string) => ({
        ...commandWatch(sentinel),
        'change-detection': { strategy: 'text-diff', typo: true },
      }),
      details: ['scope/change-detection', 'additional', 'typo'],
    },
    {
      name: 'wrong type',
      watch: (sentinel: string) => ({
        ...commandWatch(sentinel),
        interval: 42,
      }),
      details: ['scope/interval', 'string'],
    },
    {
      name: 'missing required field',
      watch: () => ({ type: 'schedule', timezone: 'UTC' }),
      details: ['scope', 'required', 'cron'],
    },
    {
      name: 'nested collection item',
      watch: (sentinel: string) => ({
        ...commandWatch(sentinel),
        'change-detection': {
          strategy: 'json-diff',
          collection: { path: 'items', key: 'id', 'ignore-paths': [42] },
        },
      }),
      details: ['scope/change-detection/collection/ignore-paths/0', 'string'],
    },
    {
      name: 'nested collection required field',
      watch: (sentinel: string) => ({
        ...commandWatch(sentinel),
        'change-detection': {
          strategy: 'json-diff',
          collection: { path: 'items' },
        },
      }),
      details: ['scope/change-detection/collection', 'required', 'key'],
    },
    {
      name: 'collection strategy constraint',
      watch: (sentinel: string) => ({
        ...commandWatch(sentinel),
        'change-detection': {
          strategy: 'text-diff',
          collection: { path: 'items', key: 'id' },
        },
      }),
      details: ['change-detection.collection requires strategy: json-diff'],
    },
    {
      name: 'nested composite part',
      watch: () => ({
        type: 'api-poll',
        'change-detection': {
          composite: {
            'object-key': 'combined',
            parts: [
              { id: 'valid', url },
              { id: 42, url },
            ],
          },
        },
      }),
      details: ['scope/change-detection/composite/parts/1/id', 'string'],
    },
  ];

  it.each(cases)(
    'rejects $name identically before source side effects',
    async ({ name, watch, details }) => {
      requests = 0;
      const sentinel = path.join(root, `${name}.sentinel`);
      const { dir, file, monitors } = writeMonitor(
        name.replaceAll(' ', '-'),
        watch(sentinel),
      );
      let diagnosis: string | undefined;
      for (const format of ['json', 'text']) {
        const validate = await run(
          ['validate', monitors, '--format', format],
          dir,
        );
        expect(validate.exitCode).toBe(1);
        expect(validate.stderr).toBe('');
        if (format === 'json') {
          const report = JSON.parse(validate.stdout) as {
            valid: number;
            invalid: number;
            errors: { filePath: string; error: string }[];
          };
          expect(report).toMatchObject({ valid: 0, invalid: 1 });
          expect(report.errors).toHaveLength(1);
          diagnosis = report.errors[0]?.error;
          expect(diagnosis).toBeTruthy();
          for (const detail of details) {
            expect(diagnosis).toContain(detail);
          }
        } else {
          expect(validate.stdout).toBe(
            `\nInvalid monitors: 1\n  ${name.replaceAll(' ', '-')}: ${diagnosis}\n`,
          );
        }
        expect(requests).toBe(0);
        expect(existsSync(sentinel)).toBe(false);

        const exercise = await run(
          ['monitor', 'test', file, '--format', format],
          dir,
        );
        // Check the effect before the diagnostic: observing then rejecting is unsafe.
        expect(requests).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        expect(exercise.exitCode).toBe(1);
        if (format === 'json') {
          expect(exercise.stderr).toBe('');
          expect(JSON.parse(exercise.stdout)).toEqual({
            error: `Invalid monitor scope: ${diagnosis}`,
          });
        } else {
          expect(exercise.stdout).toBe('');
          expect(exercise.stderr).toBe(
            `Error: Invalid monitor scope: ${diagnosis}\n`,
          );
        }
      }
    },
    // Four subprocess bounds fit inside the test budget, preserving diagnostics.
    45_000,
  );

  it('makes both side-effect sentinels observable for valid configurations', async () => {
    requests = 0;
    const api = writeMonitor('valid-api', { type: 'api-poll', url });
    expect(
      (await run(['monitor', 'test', api.file, '--format', 'json'], api.dir))
        .exitCode,
    ).toBe(0);
    expect(requests).toBeGreaterThan(0);

    const sentinel = path.join(root, 'valid-command.sentinel');
    const command = writeMonitor('valid-command', commandWatch(sentinel));
    expect(
      (
        await run(
          ['monitor', 'test', command.file, '--format', 'json'],
          command.dir,
        )
      ).exitCode,
    ).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  }, 25_000);
});
