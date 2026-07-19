/**
 * Tests for the `command-poll` observation source.
 *
 * Correctness is asserted against the normative design in
 * `docs/specs/003-source-plugins.md` §11 (§11.1–§11.7). Each test cites the
 * acceptance criterion (AC1–AC6 from issue #86) and/or the spec section it proves.
 *
 * The tests spawn tiny real subprocesses (`node -e …`) so the no-shell spawn path is
 * genuinely exercised — not a hand-built approximation. Dates are fixed; no network.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ObservationContext,
  ObservationResult,
} from '@agentmonitors/core';
import source from './index.js';

/**
 * Probe pgrep availability once at module load so `describe.skipIf` has a
 * synchronous boolean — it cannot await a promise. pgrep exits 1 when there
 * are no matches (normal); ENOENT means it's not installed at all.
 */
function probePgrep(): boolean {
  try {
    execFileSync('pgrep', ['-P', '0'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    const err = e as { code?: string | number };
    // exit code 1 = no matches — pgrep IS available, just found nothing
    // ENOENT = binary not found — pgrep is NOT available
    return err.code !== 'ENOENT';
  }
}

const PGREP_AVAILABLE = probePgrep();

const NOW = new Date('2026-06-12T00:00:00.000Z');

/** A context whose `now` is a fixed constant (never `Date.now()`). */
function ctx(previousState?: unknown): ObservationContext {
  return previousState === undefined
    ? { now: NOW }
    : { now: NOW, previousState };
}

/** argv that runs an inline Node program — a real subprocess, no shell. */
function nodeArgv(program: string): string[] {
  return [process.execPath, '-e', program];
}

describe('source-command-poll', () => {
  it('has the correct name, is stateful, and exposes a scopeSchema (003 §11)', () => {
    expect(source.name).toBe('command-poll');
    expect(source.stateful).toBe(true);
    expect(source.scopeSchema).toHaveProperty('properties');
    expect(source.scopeSchema['required']).toEqual(['command']);
  });

  describe('config validation (003 §11.1)', () => {
    it('rejects a missing command', async () => {
      await expect(source.observe({}, ctx())).rejects.toThrow('command');
    });

    it('rejects an empty command array (minItems: 1)', async () => {
      await expect(source.observe({ command: [] }, ctx())).rejects.toThrow(
        'command',
      );
    });

    it('rejects a non-array command (shell string form)', async () => {
      await expect(
        source.observe({ command: 'echo hi' }, ctx()),
      ).rejects.toThrow('command');
    });

    it('guides a bare-string command toward the sh -c argv form (003 §11.1)', async () => {
      // A pipeline written as a bare string is the most common mistake; the error
      // must teach the supported inline form rather than just rejecting it.
      await expect(
        source.observe({ command: 'git status | grep main' }, ctx()),
      ).rejects.toThrow(/\["sh", "-c", "git status \| grep main"\]/);
    });

    it('accepts an explicit sh -c argv form (the supported pipeline idiom)', async () => {
      // ["sh","-c","<pipeline>"] is a valid argv array — shell features are opt-in
      // by spawning a shell explicitly, not by the source word-splitting a string.
      const baseline = await source.observe(
        { command: ['sh', '-c', 'printf one'] },
        ctx(),
      );
      expect(baseline.observations).toHaveLength(0);
      const changed = await source.observe(
        { command: ['sh', '-c', 'printf two'] },
        ctx(baseline.nextState),
      );
      expect(changed.observations).toHaveLength(1);
      expect(changed.observations[0]?.title).toContain(
        'Command output changed',
      );
    });
  });

  // AC1 — no shell: a shell-metacharacter argv element is passed through verbatim.
  describe('AC1: no shell involvement (003 §11.1/§11.7)', () => {
    it('passes shell metacharacters through as a literal argument', async () => {
      const metachars = '$(whoami); rm -rf /tmp/x && echo pwned `id` | cat';
      // `node -e` prints argv[1] verbatim; if a shell were involved, the command
      // substitution / pipes / redirection would be interpreted instead.
      const result = await source.observe(
        {
          command: [
            ...nodeArgv('process.stdout.write(process.argv[1])'),
            metachars,
          ],
        },
        ctx({
          stdout: 'baseline-differs',
          exitCode: 0,
          truncated: false,
          health: 'ok',
          baselined: true,
        }),
      );
      expect(result.observations).toHaveLength(1);
      const payload = result.observations[0]?.payload as { stdout: string };
      // The metacharacters appear verbatim — proving no word-splitting, no
      // command substitution, no globbing: exactly what the author wrote.
      expect(payload.stdout).toBe(metachars);
      expect(payload.stdout).toContain('$(whoami)');
      expect(payload.stdout).toContain('rm -rf /tmp/x');
    });
  });

  // AC2 — baseline emits nothing; each strategy detects its change class.
  describe('AC2: baseline and change-detection strategies (003 §11.3/§11.4)', () => {
    it('baseline run emits nothing and stores state', async () => {
      const result = await source.observe(
        { command: nodeArgv('process.stdout.write("v1")') },
        ctx(),
      );
      expect(result.observations).toHaveLength(0);
      expect(result.nextState).toMatchObject({ health: 'ok', baselined: true });
    });

    it('text-diff (default): detects a stdout change', async () => {
      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("v1")') },
        ctx(),
      );
      const changed = await source.observe(
        { command: nodeArgv('process.stdout.write("v2")') },
        ctx(baseline.nextState),
      );
      expect(changed.observations).toHaveLength(1);
      expect(changed.observations[0]?.title).toContain(
        'Command output changed',
      );
    });

    it('text-diff: identical stdout emits nothing', async () => {
      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("same")') },
        ctx(),
      );
      const same = await source.observe(
        { command: nodeArgv('process.stdout.write("same")') },
        ctx(baseline.nextState),
      );
      expect(same.observations).toHaveLength(0);
    });

    it('exit-code: ignores stdout-only changes, fires on exit-code change', async () => {
      const config = {
        command: nodeArgv('process.stdout.write("v1")'),
        'change-detection': { strategy: 'exit-code' },
      };
      const baseline = await source.observe(config, ctx());

      // Different stdout, same exit code 0 — must NOT fire under exit-code.
      const stdoutOnly = await source.observe(
        {
          command: nodeArgv('process.stdout.write("v2-different")'),
          'change-detection': { strategy: 'exit-code' },
        },
        ctx(baseline.nextState),
      );
      expect(stdoutOnly.observations).toHaveLength(0);

      // Same stdout, different exit code — must fire.
      const exitChanged = await source.observe(
        {
          command: nodeArgv(
            'process.stdout.write("v2-different");process.exit(3)',
          ),
          'change-detection': { strategy: 'exit-code' },
        },
        ctx(stdoutOnly.nextState),
      );
      expect(exitChanged.observations).toHaveLength(1);
    });

    it('json-diff: ignores key reordering and whitespace', async () => {
      const config = {
        command: nodeArgv('process.stdout.write(JSON.stringify({a:1,b:2}))'),
        'change-detection': { strategy: 'json-diff' },
      };
      const baseline = await source.observe(config, ctx());

      // Same JSON, keys reordered + whitespace — must NOT fire.
      const reordered = await source.observe(
        {
          command: nodeArgv(
            'process.stdout.write("{ \\"b\\": 2,  \\"a\\": 1 }")',
          ),
          'change-detection': { strategy: 'json-diff' },
        },
        ctx(baseline.nextState),
      );
      expect(reordered.observations).toHaveLength(0);

      // Different value — must fire.
      const valueChanged = await source.observe(
        {
          command: nodeArgv('process.stdout.write(JSON.stringify({a:1,b:99}))'),
          'change-detection': { strategy: 'json-diff' },
        },
        ctx(reordered.nextState),
      );
      expect(valueChanged.observations).toHaveLength(1);
    });

    it('json-diff: top-level ignore-paths removes noisy fields before comparison', async () => {
      const config = {
        command: nodeArgv(
          'process.stdout.write(JSON.stringify({stable:"same",duration:"1m"}))',
        ),
        'change-detection': {
          strategy: 'json-diff',
          'ignore-paths': ['duration'],
        },
      };
      const baseline = await source.observe(config, ctx());

      const noisyOnly = await source.observe(
        {
          command: nodeArgv(
            'process.stdout.write(JSON.stringify({stable:"same",duration:"2m"}))',
          ),
          'change-detection': {
            strategy: 'json-diff',
            'ignore-paths': ['duration'],
          },
        },
        ctx(baseline.nextState),
      );
      expect(noisyOnly.observations).toHaveLength(0);

      const stableChanged = await source.observe(
        {
          command: nodeArgv(
            'process.stdout.write(JSON.stringify({stable:"changed",duration:"3m"}))',
          ),
          'change-detection': {
            strategy: 'json-diff',
            'ignore-paths': ['duration'],
          },
        },
        ctx(noisyOnly.nextState),
      );
      expect(stableChanged.observations).toHaveLength(1);
    });
  });

  // Keyed-collection change detection (003 §12) wired through command-poll. The
  // shared diff lives in @agentmonitors/core; these verify command-poll consumes it.
  describe('keyed-collection (003 §12)', () => {
    /** argv that prints a fixed JSON document. */
    function jsonArgv(doc: unknown): string[] {
      return nodeArgv(
        `process.stdout.write(${JSON.stringify(JSON.stringify(doc))})`,
      );
    }
    const collection = { path: '$.tasks', key: 'id' };

    it('baseline run emits nothing', async () => {
      const result = await source.observe(
        {
          command: jsonArgv({ tasks: [{ id: 'a', v: 1 }] }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(),
      );
      expect(result.observations).toHaveLength(0);
    });

    it('a re-sorted collection produces zero observations', async () => {
      const baseline = await source.observe(
        {
          command: jsonArgv({
            tasks: [
              { id: 'a', v: 1 },
              { id: 'b', v: 2 },
            ],
          }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(),
      );
      const next = await source.observe(
        {
          command: jsonArgv({
            tasks: [
              { id: 'b', v: 2 },
              { id: 'a', v: 1 },
            ],
          }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(baseline.nextState),
      );
      expect(next.observations).toHaveLength(0);
    });

    it('one element changing → exactly one modified with keyed objectKey', async () => {
      const key = 'tasks';
      const baseline = await source.observe(
        {
          command: jsonArgv({
            tasks: [
              { id: 'a', v: 1 },
              { id: 'b', v: 2 },
            ],
          }),
          key,
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(),
      );
      const next = await source.observe(
        {
          command: jsonArgv({
            tasks: [
              { id: 'a', v: 1 },
              { id: 'b', v: 99 },
            ],
          }),
          key,
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(baseline.nextState),
      );
      expect(next.observations).toHaveLength(1);
      expect(next.observations[0]?.changeKind).toBe('modified');
      expect(next.observations[0]?.objectKey).toBe('tasks#b');
    });

    it('accepts a bare dotted collection path and reports per-item changes', async () => {
      const key = 'items';
      const barePathCollection = { path: 'items', key: 'id' };
      const baseline = await source.observe(
        {
          command: jsonArgv({ items: [{ id: 'x', name: 'A' }] }),
          key,
          'change-detection': {
            strategy: 'json-diff',
            collection: barePathCollection,
          },
        },
        ctx(),
      );

      const modified = await source.observe(
        {
          command: jsonArgv({ items: [{ id: 'x', name: 'B' }] }),
          key,
          'change-detection': {
            strategy: 'json-diff',
            collection: barePathCollection,
          },
        },
        ctx(baseline.nextState),
      );
      expect(modified.observations).toHaveLength(1);
      expect(modified.observations[0]?.changeKind).toBe('modified');
      expect(modified.observations[0]?.objectKey).toBe('items#x');

      const created = await source.observe(
        {
          command: jsonArgv({
            items: [
              { id: 'x', name: 'B' },
              { id: 'y', name: 'C' },
            ],
          }),
          key,
          'change-detection': {
            strategy: 'json-diff',
            collection: barePathCollection,
          },
        },
        ctx(modified.nextState),
      );
      expect(created.observations).toHaveLength(1);
      expect(created.observations[0]?.changeKind).toBe('created');
      expect(created.observations[0]?.objectKey).toBe('items#y');

      const descoped = await source.observe(
        {
          command: jsonArgv({ items: [{ id: 'x', name: 'B' }] }),
          key,
          'change-detection': {
            strategy: 'json-diff',
            collection: barePathCollection,
          },
        },
        ctx(created.nextState),
      );
      expect(descoped.observations).toHaveLength(1);
      expect(descoped.observations[0]?.changeKind).toBe('descoped');
      expect(descoped.observations[0]?.objectKey).toBe('items#y');
    });

    it('element addition → created; removal → descoped (not deleted)', async () => {
      const baseline = await source.observe(
        {
          command: jsonArgv({ tasks: [{ id: 'a', v: 1 }] }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(),
      );
      const added = await source.observe(
        {
          command: jsonArgv({
            tasks: [
              { id: 'a', v: 1 },
              { id: 'b', v: 2 },
            ],
          }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(baseline.nextState),
      );
      expect(added.observations).toHaveLength(1);
      expect(added.observations[0]?.changeKind).toBe('created');

      const removed = await source.observe(
        {
          command: jsonArgv({ tasks: [{ id: 'a', v: 1 }] }),
          'change-detection': { strategy: 'json-diff', collection },
        },
        ctx(added.nextState),
      );
      expect(removed.observations).toHaveLength(1);
      expect(removed.observations[0]?.changeKind).toBe('descoped');
      expect(removed.observations[0]?.changeKind).not.toBe('deleted');
    });

    it('ignore-paths removes churn fields before comparison', async () => {
      const cfg = {
        path: '$.tasks',
        key: 'id',
        'ignore-paths': ['$.fetchedAt'],
      };
      const baseline = await source.observe(
        {
          command: jsonArgv({ tasks: [{ id: 'a', v: 1, fetchedAt: 't0' }] }),
          'change-detection': { strategy: 'json-diff', collection: cfg },
        },
        ctx(),
      );
      const next = await source.observe(
        {
          command: jsonArgv({ tasks: [{ id: 'a', v: 1, fetchedAt: 't1' }] }),
          'change-detection': { strategy: 'json-diff', collection: cfg },
        },
        ctx(baseline.nextState),
      );
      expect(next.observations).toHaveLength(0);
    });

    it('rejects collection under a non-json-diff strategy at observe time', async () => {
      await expect(
        source.observe(
          {
            command: jsonArgv({ tasks: [] }),
            'change-detection': { strategy: 'text-diff', collection },
          },
          ctx(),
        ),
      ).rejects.toThrow(/requires strategy: json-diff/);
    });
  });

  // AC3 — nonzero exit WITH changed output is a result, diffed and reported.
  describe('AC3: nonzero-exit result is diffed, not swallowed (003 §11.2/§11.7)', () => {
    it('reports a changed nonzero-exit output as an observation', async () => {
      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("first");process.exit(2)') },
        ctx(),
      );
      // Baseline establishes state even though exit code is nonzero (a result).
      expect(baseline.observations).toHaveLength(0);
      expect(baseline.nextState).toMatchObject({
        exitCode: 2,
        health: 'ok',
        baselined: true,
      });

      const changed = await source.observe(
        { command: nodeArgv('process.stdout.write("second");process.exit(2)') },
        ctx(baseline.nextState),
      );
      expect(changed.observations).toHaveLength(1);
      expect(changed.observations[0]?.title).toContain(
        'Command output changed',
      );
      const payload = changed.observations[0]?.payload as { exitCode: number };
      expect(payload.exitCode).toBe(2);
    });
  });

  // AC4 — failure (spawn + timeout) transition-edge semantics.
  describe('AC4: transition-edge failure semantics (003 §11.5)', () => {
    it('spawn failure: one ok→failing, silent while failing, failing→ok on recovery', async () => {
      const badBinary = {
        command: ['this-binary-does-not-exist-agentmonitors-xyz'],
      };
      const goodWith = (out: string) => ({
        command: nodeArgv(`process.stdout.write(${JSON.stringify(out)})`),
      });

      // Establish a real baseline first.
      const baseline = await source.observe(goodWith('output-A'), ctx());
      expect(baseline.observations).toHaveLength(0);

      // First failure: ok → failing, exactly one observation.
      const fail1 = await source.observe(badBinary, ctx(baseline.nextState));
      expect(fail1.observations).toHaveLength(1);
      expect(fail1.observations[0]?.title).toContain('Command failing');
      // Prior baseline is kept untouched (no state loss).
      expect(fail1.nextState).toMatchObject({
        stdout: 'output-A',
        health: 'failing',
        baselined: true,
      });

      // Second consecutive failure: silent.
      const fail2 = await source.observe(badBinary, ctx(fail1.nextState));
      expect(fail2.observations).toHaveLength(0);

      // Recovery WITH changed output: recovered + output-changed (two observations).
      const recovered = await source.observe(
        goodWith('output-B'),
        ctx(fail2.nextState),
      );
      const titles = recovered.observations.map((o) => o.title);
      expect(titles).toContainEqual(
        expect.stringContaining('Command recovered'),
      );
      expect(titles).toContainEqual(
        expect.stringContaining('Command output changed'),
      );
      expect(recovered.observations).toHaveLength(2);
    });

    it('recovery with UNCHANGED output emits only the recovered observation', async () => {
      const good = {
        command: nodeArgv('process.stdout.write("stable")'),
      };
      const bad = { command: ['nope-agentmonitors-missing-bin'] };

      const baseline = await source.observe(good, ctx());
      const failing = await source.observe(bad, ctx(baseline.nextState));
      expect(failing.observations).toHaveLength(1);

      const recovered = await source.observe(good, ctx(failing.nextState));
      expect(recovered.observations).toHaveLength(1);
      expect(recovered.observations[0]?.title).toContain('Command recovered');
    });

    it('timeout: a hung child fails with one ok→failing observation', async () => {
      // A child that sleeps far longer than the timeout. `setTimeout` keeps it
      // alive; the source's SIGTERM tears it down at the 100ms timeout.
      const hung = {
        command: nodeArgv('setTimeout(() => {}, 60000)'),
        timeout: '1s',
      };
      // Establish baseline with a fast success.
      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("ok")') },
        ctx(),
      );

      const timedOut = await source.observe(hung, ctx(baseline.nextState));
      expect(timedOut.observations).toHaveLength(1);
      expect(timedOut.observations[0]?.title).toContain('Command failing');
      const payload = timedOut.observations[0]?.payload as { error: string };
      expect(payload.error).toMatch(/timed out/i);
      expect(timedOut.nextState).toMatchObject({ health: 'failing' });
    });

    it('a failing first run establishes no baseline; first success baselines silently for output', async () => {
      const bad = { command: ['definitely-not-a-real-binary-am'] };

      // First-ever run fails: one ok→failing observation, baselined:false.
      const fail = await source.observe(bad, ctx());
      expect(fail.observations).toHaveLength(1);
      expect(fail.observations[0]?.title).toContain('Command failing');
      expect(fail.nextState).toMatchObject({
        health: 'failing',
        baselined: false,
      });

      // First success after a failing first run: emits the recovered edge, but
      // does NOT emit an output-changed observation (no pre-failure baseline).
      const recovered = await source.observe(
        { command: nodeArgv('process.stdout.write("hello")') },
        ctx(fail.nextState),
      );
      expect(recovered.observations).toHaveLength(1);
      expect(recovered.observations[0]?.title).toContain('Command recovered');
      expect(recovered.nextState).toMatchObject({
        stdout: 'hello',
        health: 'ok',
        baselined: true,
      });
    });
  });

  // AC5 — env reaches the child but is never persisted.
  describe('AC5: env reaches the child, never persisted (003 §11.1)', () => {
    it('passes env to the child but excludes the env config from all persisted artifacts', async () => {
      const SECRET = 'super-secret-token-value-9f3a';
      // The child observes its env value but emits only a NON-secret derived marker
      // (the length), proving env arrived without echoing the raw value to stdout.
      const program =
        'process.stdout.write("seen-len:" + (process.env.MY_SECRET || "").length)';
      const baseline = await source.observe(
        { command: nodeArgv(program), env: { MY_SECRET: SECRET } },
        ctx(),
      );

      // The env value never appears in any persisted state row.
      expect(JSON.stringify(baseline.nextState)).not.toContain(SECRET);
      // The child DID receive the env var (length 29, not 0).
      expect((baseline.nextState as { stdout: string }).stdout).toBe(
        `seen-len:${String(SECRET.length)}`,
      );

      // Rotate to a different secret so an observation fires (the marker changes).
      const SECRET2 = 'rotated-secret-value-different-length-1b2c';
      const result = await source.observe(
        { command: nodeArgv(program), env: { MY_SECRET: SECRET2 } },
        ctx(baseline.nextState),
      );
      expect(result.observations).toHaveLength(1);
      // The change is observable (the env-derived marker differs).
      expect(result.observations[0]?.snapshotText).toBe(
        `seen-len:${String(SECRET2.length)}`,
      );

      // No env value and no `env` config key in any persisted artifact.
      const obs = result.observations[0];
      const payload = obs?.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty('env');
      expect(Object.keys(payload)).toEqual([
        'command',
        'exitCode',
        'strategy',
        'stdout',
        'truncated',
      ]);
      // The full serialized observation (every persisted field) plus the state row
      // contains neither env value. (Note: the argv legitimately appears in `payload.
      // command` / `objectKey`, so we assert on env VALUES, not on the var name, which
      // is part of the command the author wrote.)
      const serializedAll = JSON.stringify([
        obs?.payload,
        obs?.snapshot,
        obs?.snapshotText,
        obs?.queryScope,
        result.nextState,
      ]);
      expect(serializedAll).not.toContain(SECRET);
      expect(serializedAll).not.toContain(SECRET2);
    });
  });

  // AC6 (part 1) — truncation: >1 MiB captures diff stably.
  describe('AC6: 1 MiB truncation diffs stably (003 §11.2/§11.7)', () => {
    it('marks truncated and produces stable diffs across identical leading content', async () => {
      // Emit 2 MiB of a single repeated byte — well over the 1 MiB cap.
      const bigOutput = nodeArgv(
        'process.stdout.write("a".repeat(2 * 1024 * 1024))',
      );
      const baseline = await source.observe({ command: bigOutput }, ctx());
      expect(baseline.nextState).toMatchObject({ truncated: true });

      // A second run with identical leading content (also 2 MiB of "a") must NOT
      // report a change — the capped slice is identical, over the bounded retained
      // stdout (the same leading STDOUT_CAP_BYTES survive both runs).
      const second = await source.observe(
        { command: bigOutput },
        ctx(baseline.nextState),
      );
      expect(second.observations).toHaveLength(0);

      // The stored stdout is capped at exactly 1 MiB.
      const state = second.nextState as { stdout: string; truncated: boolean };
      expect(state.stdout.length).toBe(1024 * 1024);
      expect(state.truncated).toBe(true);
    });
  });

  // Drain, don't kill: a command producing more than the cap on either stream must
  // still run to completion and report its real exit status (issue #302).
  describe('drains excess output without killing the process (003 §11.2, issue #302)', () => {
    it('>1 MiB stdout: a marker side effect after the overflow still lands, and the real exit code (7) is reported', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-302-stdout-'));
      const markerFile = join(dir, 'marker');
      try {
        // Emit 2 MiB of stdout — well past the 1 MiB cap — THEN perform a side
        // effect and exit nonzero. If the old execFile({ maxBuffer }) behavior were
        // still in play, the child would be SIGKILLed the moment it crossed the
        // cap: the marker would never be written and the real exit code (7) would
        // never be observed (a killed process has no exit code, and the old code
        // fabricated 0). Both landing proves the process ran to real completion.
        // `process.exitCode` (not `process.exit()`) so Node waits for the
        // stdout stream to actually drain before the process terminates — an
        // explicit `process.exit()` right after a large write truncates output
        // at whatever the pipe had buffered, which would make this test flaky
        // for reasons unrelated to the source's own draining behavior.
        const command = nodeArgv(
          `process.stdout.write("a".repeat(2 * 1024 * 1024)); ` +
            `require("fs").writeFileSync(${JSON.stringify(markerFile)}, "done"); ` +
            `process.exitCode = 7`,
        );

        const result = await source.observe({ command }, ctx());

        expect(readFileSync(markerFile, 'utf8')).toBe('done');
        const state = result.nextState as {
          exitCode: number;
          truncated: boolean;
          stdout: string;
        };
        expect(state.exitCode).toBe(7);
        expect(state.truncated).toBe(true);
        expect(state.stdout.length).toBe(1024 * 1024);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('>1 MiB stderr with small stdout: stdout is captured intact and the real exit code is reported', async () => {
      // A large stderr volume must never affect stdout capture or cause a failure —
      // stderr's retention cap is independent of stdout's (issue #302).
      const command = nodeArgv(
        `process.stderr.write("e".repeat(2 * 1024 * 1024)); ` +
          `process.stdout.write("small-stdout"); ` +
          `process.exitCode = 3`,
      );

      const result = await source.observe({ command }, ctx());

      const state = result.nextState as {
        exitCode: number;
        truncated: boolean;
        stdout: string;
      };
      expect(state.exitCode).toBe(3);
      // stdout never crossed its own cap — not truncated.
      expect(state.truncated).toBe(false);
      expect(state.stdout).toBe('small-stdout');
    });

    it('simultaneous large stdout and stderr: both are drained and the real exit code is reported', async () => {
      const command = nodeArgv(
        `process.stderr.write("e".repeat(2 * 1024 * 1024)); ` +
          `process.stdout.write("a".repeat(2 * 1024 * 1024)); ` +
          `process.exitCode = 5`,
      );

      const result = await source.observe({ command }, ctx());

      const state = result.nextState as {
        exitCode: number;
        truncated: boolean;
        stdout: string;
      };
      expect(state.exitCode).toBe(5);
      expect(state.truncated).toBe(true);
      expect(state.stdout.length).toBe(1024 * 1024);
    });

    // Negative test: a command that would exceed the cap on both streams AND keeps
    // writing well past it must still resolve promptly, not hang the tick waiting
    // for a kill or for buffers to "settle" — draining, not blocking, is what keeps
    // this bounded.
    it('a command that keeps writing far past the cap on both streams still resolves promptly', async () => {
      const command = nodeArgv(
        `process.stderr.write("e".repeat(4 * 1024 * 1024)); ` +
          `process.stdout.write("a".repeat(4 * 1024 * 1024)); ` +
          `process.exitCode = 0`,
      );

      // Resolving at all (rather than hanging until the 30s default timeout)
      // proves the child was drained, not blocked on a full pipe buffer waiting
      // for us to read. A wall-clock upper bound here was flaky under CI load,
      // so timing isn't asserted directly — `ctx()`'s test timeout is the
      // enforcement backstop.
      const result = await source.observe({ command }, ctx());
      const state = result.nextState as {
        exitCode: number;
        truncated: boolean;
      };
      expect(state.exitCode).toBe(0);
      expect(state.truncated).toBe(true);
    });

    // Regression test for issue #302: the stderr diagnostic tail is exposed via
    // the `stderrTail` failure payload, sliced to the last `STDERR_TAIL_CHARS`
    // (2000) characters of the last `STDERR_RETENTION_CAP_BYTES` (8000) retained
    // bytes. A whole-chunk eviction scheme (`chunks.shift()` while
    // `chunks.length > 1`) drops the *entire* oldest chunk once the retained
    // total exceeds the cap — so a large leading chunk followed by a tiny final
    // chunk loses everything but that tiny chunk, instead of the correct
    // trailing window spanning both. The per-chunk `Buffer.concat(...).subarray(
    // -cap)` form used here stays byte-accurate regardless of how the writes are
    // chunked.
    it('big-chunk-then-tiny-chunk: the failure stderrTail is the full 2000-char trailing window (issue #302)', async () => {
      const bigChunkChars = 9000; // > STDERR_RETENTION_CAP_BYTES (8000)
      const tinyChunkChars = 7;
      const command = nodeArgv(
        `process.stderr.write(Buffer.alloc(${String(bigChunkChars)}, 'A'), () => { ` +
          `setTimeout(() => { ` +
          `process.stderr.write('B'.repeat(${String(tinyChunkChars)}), () => { ` +
          `setTimeout(() => {}, 60000); ` +
          `}); ` +
          `}, 50); ` +
          `});`,
      );

      const result = await source.observe({ command, timeout: '1s' }, ctx());

      expect(result.observations).toHaveLength(1);
      const payload = result.observations[0]?.payload as {
        error: string;
        stderrTail: string;
      };
      expect(payload.error).toMatch(/timed out/i);
      // Full 2000-char trailing window: 1993 trailing `A`s from the big chunk,
      // followed by all 7 `B`s from the tiny final chunk — never just the 7
      // characters of the last chunk alone.
      expect(payload.stderrTail).toHaveLength(2000);
      expect(payload.stderrTail).toBe(
        'A'.repeat(2000 - tinyChunkChars) + 'B'.repeat(tinyChunkChars),
      );
    });

    it('a single ~8x-over-cap chunk followed by one tiny chunk still yields the correct bounded tail (issue #302)', async () => {
      // The first (and, in isolation, only) chunk is ~8x STDERR_RETENTION_CAP_BYTES
      // (8000) on its own — the buggy `chunks.length > 1` guard never trims a
      // solitary chunk no matter how far over the cap it is, and then evicts it
      // WHOLE (rather than trimming) the moment a second chunk arrives.
      const bigChunkChars = 64_000;
      const command = nodeArgv(
        `process.stderr.write(Buffer.alloc(${String(bigChunkChars)}, 'C'), () => { ` +
          `setTimeout(() => { ` +
          `process.stderr.write('D', () => { ` +
          `setTimeout(() => {}, 60000); ` +
          `}); ` +
          `}, 50); ` +
          `});`,
      );

      const result = await source.observe({ command, timeout: '1s' }, ctx());

      expect(result.observations).toHaveLength(1);
      const payload = result.observations[0]?.payload as {
        error: string;
        stderrTail: string;
      };
      expect(payload.error).toMatch(/timed out/i);
      expect(payload.stderrTail).toHaveLength(2000);
      expect(payload.stderrTail).toBe('C'.repeat(1999) + 'D');
    });
  });

  describe('observation identity (003 §11.4)', () => {
    it('defaults objectKey to the joined argv and honors a key override', async () => {
      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("x")') },
        ctx(),
      );
      const changed = await source.observe(
        { command: nodeArgv('process.stdout.write("y")') },
        ctx(baseline.nextState),
      );
      const obs = changed.observations[0];
      expect(obs?.objectKey).toBe(
        nodeArgv('process.stdout.write("y")').join(' '),
      );
      expect(obs?.changeKind).toBe('modified');
      expect(obs?.queryScope).toEqual({ command: obs?.objectKey });

      // `key` override.
      const baseKeyed = await source.observe(
        { command: nodeArgv('process.stdout.write("a")'), key: 'my-key' },
        ctx(),
      );
      const keyed = await source.observe(
        { command: nodeArgv('process.stdout.write("b")'), key: 'my-key' },
        ctx(baseKeyed.nextState),
      );
      expect(keyed.observations[0]?.objectKey).toBe('my-key');
      expect(keyed.observations[0]?.title).toBe(
        'Command output changed: my-key',
      );
    });

    // 003 §11.4: snapshot.command is the argv array, not the objectKey string.
    it('snapshot.command is the argv array, not objectKey (003 §11.4)', async () => {
      const argv = nodeArgv('process.stdout.write("snap-test")');
      const baseline = await source.observe({ command: argv }, ctx());
      const changed = await source.observe(
        { command: nodeArgv('process.stdout.write("snap-test-2")') },
        ctx(baseline.nextState),
      );
      const obs = changed.observations[0];
      const snapshot = obs?.snapshot as {
        command: unknown;
        exitCode: number;
        stdoutLength: number;
        strategy: string;
      };
      // snapshot.command must be the argv array, not the objectKey string.
      expect(snapshot.command).toEqual(
        nodeArgv('process.stdout.write("snap-test-2")'),
      );
      expect(Array.isArray(snapshot.command)).toBe(true);
      // snapshot.command and payload.command refer to the same data.
      const payload = obs?.payload as { command: string[] };
      expect(snapshot.command).toEqual(payload.command);
    });
  });

  describe('isCommandState guard (003 §11.4)', () => {
    // Regression test: a malformed previousState with non-boolean `truncated`
    // must be rejected by the guard and re-baselined, not re-persisted.
    it('re-baselines when previousState has non-boolean truncated', async () => {
      // Inject a state where truncated is a string instead of boolean.
      const malformedState = {
        stdout: 'old-output',
        exitCode: 0,
        truncated: 'yes', // invalid — should be boolean
        health: 'ok',
        baselined: true,
      };
      // With a valid prior baseline accepted, a changed output would emit an observation.
      // With the malformed state rejected, the source re-baselines silently (no observation).
      const result = await source.observe(
        { command: nodeArgv('process.stdout.write("new-output")') },
        ctx(malformedState),
      );
      // Re-baselined: no observation emitted (same behavior as first-ever run).
      expect(result.observations).toHaveLength(0);
      expect(result.nextState).toMatchObject({
        stdout: 'new-output',
        health: 'ok',
        baselined: true,
        truncated: false,
      });
    });
  });
});

/**
 * Process-leak guard: assert the spawned-children count returns to baseline.
 * Skipped on platforms where `pgrep` is unavailable — without it the helper
 * always returns 0 and the test would pass vacuously (003 §11.7).
 */
describe.skipIf(!PGREP_AVAILABLE)(
  'source-command-poll: no orphan processes (003 §11.7)',
  () => {
    let baselineChildCount = 0;

    afterEach(async () => {
      // Allow any lingering teardown to settle, then confirm no extra children leaked.
      await new Promise((r) => setTimeout(r, 50));
    });

    it('a timed-out child leaves no orphan (killed within the grace window)', async () => {
      baselineChildCount = await childProcessCount();

      const hung = {
        command: nodeArgv('setTimeout(() => {}, 60000)'),
        timeout: '1s',
      };
      const result: ObservationResult = await source.observe(hung, {
        now: NOW,
      });
      expect(result.observations).toHaveLength(1);

      // Give SIGTERM time to land (timeout 1s already elapsed; the child exits on TERM).
      await new Promise((r) => setTimeout(r, 200));
      const after = await childProcessCount();
      expect(after).toBeLessThanOrEqual(baselineChildCount);
    });
  },
);

/**
 * Regression test for issue #303: `command-poll` timeout previously signaled only
 * the direct child (`child.kill()`), so a command that backgrounds a worker via a
 * shell — `sh -c 'sleep 30 & wait'`, the repro from the issue — left the `sleep`
 * grandchild running after the shell was killed. `pgrep -P <thisProcess>` (used by
 * the block above) can never catch this: `sleep`'s parent is the shell, not this
 * test process, so a grandchild leak is invisible to a direct-children-only check
 * even before the kernel reparents it away. This test instead captures the
 * grandchild's own PID (the same way the issue's repro does) and asserts by PID —
 * independent of process-tree membership, so it still catches an orphan after
 * reparenting.
 *
 * Skipped on Windows: `sh` and POSIX process-group semantics don't apply there.
 * The Windows tree-kill path (`taskkill /T /F` in `killProcessTree`) is exercised
 * by the ordinary timeout test above on every platform (direct-child kill), which
 * proves the code path executes; verifying POSIX process-group semantics
 * specifically needs `sh`.
 */
describe.skipIf(process.platform === 'win32')(
  'source-command-poll: timed-out sh -c descendant is fully terminated (003 §11.7, issue #303)',
  () => {
    it('kills the backgrounded grandchild, not just the shell', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-303-'));
      const pidFile = join(dir, 'child.pid');
      try {
        const hung = {
          command: ['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`],
          timeout: '1s',
        };

        const start = Date.now();
        const result = await source.observe(hung, ctx());
        const elapsed = Date.now() - start;

        // Same transition-edge failure semantics as any other timeout (003 §11.5)
        // — this fix must not change that.
        expect(result.observations).toHaveLength(1);
        expect(result.observations[0]?.title).toContain('Command failing');
        const payload = result.observations[0]?.payload as { error: string };
        expect(payload.error).toMatch(/timed out/i);
        expect(result.nextState).toMatchObject({ health: 'failing' });

        // Resolves within timeout + grace + slack — never hangs waiting on the
        // grandchild's inherited stdout/stderr streams to close (003 §11.7).
        expect(elapsed).toBeLessThan(1_000 + 5_000 + 3_000);

        const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(Number.isInteger(grandchildPid)).toBe(true);

        // Poll for the grandchild's death with a deadline rather than a fixed
        // sleep — SIGKILL delivery after the grace period is not instantaneous.
        const dead = await pollUntil(
          () => !isProcessAlive(grandchildPid),
          6_000,
        );
        expect(dead).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * Regression test for the Copilot finding on PR #430 (issue #303): the direct
     * child can exit on SIGTERM (its own disposition is default-terminate) while a
     * descendant it backgrounded has SIGTERM disposition set to ignore — inherited
     * via `exec` from a subshell that trapped it — and so survives the group
     * SIGTERM untouched. The buggy code cleared the pending SIGKILL grace-timer as
     * soon as `finish()` ran for the direct child's `exit` event, cancelling the
     * follow-up SIGKILL before it could ever reach the still-alive descendant. The
     * fix must let the grace timer run to completion — and unconditionally SIGKILL
     * the process group — independent of whether the direct child already exited
     * and the outer promise already settled.
     */
    it('SIGKILLs a descendant that ignores SIGTERM even though the direct shell exits on SIGTERM first', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'am-303-ignore-term-'));
      const pidFile = join(dir, 'child.pid');
      try {
        const hung = {
          command: [
            'sh',
            '-c',
            `(trap '' TERM; exec sleep 30) & echo $! > ${pidFile}; wait`,
          ],
          timeout: '1s',
        };

        const result = await source.observe(hung, ctx());

        // Same transition-edge failure semantics as any other timeout.
        expect(result.observations).toHaveLength(1);
        expect(result.observations[0]?.title).toContain('Command failing');
        const payload = result.observations[0]?.payload as { error: string };
        expect(payload.error).toMatch(/timed out/i);

        const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(Number.isInteger(grandchildPid)).toBe(true);

        // The direct shell dies on the initial SIGTERM (well within timeout +
        // slack); the descendant ignores that same SIGTERM and can only be
        // reaped by the SIGKILL the grace timer must still deliver after it —
        // proving the grace timer was not cancelled by the direct child's exit.
        const dead = await pollUntil(
          () => !isProcessAlive(grandchildPid),
          6_000,
        );
        expect(dead).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 12_000);
  },
);

/**
 * Regression test for the Copilot finding on PR #430 (issue #303): the wall-clock
 * timeout timer previously stayed armed until the promise actually settled. When
 * the direct child exits successfully but a backgrounded descendant inherits
 * stdout and holds it open, the code waits up to `CLOSE_FALLBACK_MS` for `close`
 * before falling back — and if the wall-clock timer fires during that wait, it
 * flips an already-successful exit into a reported timeout. The fix must disarm
 * the wall-clock timer the moment the direct child is known to have exited
 * normally, so it can never race the close-fallback wait.
 */
describe.skipIf(process.platform === 'win32')(
  'source-command-poll: a lingering descendant never retro-flags a successful exit as a timeout (issue #303)',
  () => {
    it('reports success, not a timeout, when a backgrounded descendant holds stdout open past the wall-clock deadline', async () => {
      // The shell echoes output and exits almost immediately; a backgrounded
      // `sleep` inherits stdout and keeps it open well past both the 1s
      // wall-clock timeout and the close-fallback window, but must never cause
      // the already-successful exit to be reported as a timeout.
      const fast = {
        command: ['sh', '-c', 'echo hi; sleep 5 & exit 0'],
        timeout: '1s',
      };

      const baseline = await source.observe(
        { command: nodeArgv('process.stdout.write("seed")') },
        ctx(),
      );

      const start = Date.now();
      const result = await source.observe(fast, ctx(baseline.nextState));
      const elapsed = Date.now() - start;

      // Resolved via the close-fallback well before the 1s wall-clock timeout
      // could have any further chance to fire.
      expect(elapsed).toBeLessThan(3_000);
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.title).toContain('Command output changed');
      expect(result.nextState).toMatchObject({
        health: 'ok',
        baselined: true,
        stdout: 'hi\n',
      });
    });
  },
);

/**
 * Whether `pid` currently identifies a live process, checked via POSIX `kill(pid,
 * 0)` semantics (no actual signal sent). Distinct from `childProcessCount`'s
 * tree-membership check: this works even after the process has been reparented
 * away from us, which is exactly what happens to an orphan.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // ESRCH: no such process — genuinely dead. Any other error (e.g. EPERM,
    // meaning it exists but we lack permission to signal it) means it is alive.
    return err.code !== 'ESRCH';
  }
}

/** Poll `predicate` until it returns true or `deadlineMs` elapses. */
async function pollUntil(
  predicate: () => boolean,
  deadlineMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/**
 * Count direct child processes of this test process via POSIX `pgrep`.
 *
 * Exit code 1 means "no matches" → 0 children (normal, not an error).
 * Any other error (ENOENT, unexpected exit code) is thrown so the test fails
 * loudly rather than passing blind — a masked leak is worse than a test failure.
 */
async function childProcessCount(): Promise<number> {
  const { execFile } = await import('node:child_process');
  return new Promise<number>((resolve, reject) => {
    execFile('pgrep', ['-P', String(process.pid)], (err, stdout) => {
      if (err) {
        const errWithCode = err as Error & { code?: string | number };
        // pgrep exits 1 when there are no matches — that is "zero children", not an error.
        if (errWithCode.code === 1) {
          resolve(0);
          return;
        }
        // Any other failure (ENOENT, unexpected exit code, etc.) means we can't
        // measure — reject so the test fails loudly rather than passing vacuously.
        reject(
          new Error(
            `pgrep failed unexpectedly (code=${String(errWithCode.code)}): ${err.message}`,
          ),
        );
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      resolve(lines.length);
    });
  });
}
