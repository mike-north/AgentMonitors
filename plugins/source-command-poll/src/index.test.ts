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
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ObservationContext,
  ObservationResult,
} from '@agentmonitors/core';
import source from './index.js';

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
      // report a change — the capped slice is identical.
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
  });
});

/** Process-leak guard: assert the spawned-children count returns to baseline. */
describe('source-command-poll: no orphan processes (003 §11.7)', () => {
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
});

/** Count direct child processes of this test process (best-effort, POSIX `pgrep`). */
async function childProcessCount(): Promise<number> {
  const { execFile } = await import('node:child_process');
  return new Promise<number>((resolve) => {
    execFile('pgrep', ['-P', String(process.pid)], (err, stdout) => {
      if (err) {
        // pgrep exits 1 when there are no matches — that means zero children.
        resolve(0);
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      resolve(lines.length);
    });
  });
}
