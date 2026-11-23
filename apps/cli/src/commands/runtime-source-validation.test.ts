/** Built CLI proof that preflight is visible and precedes command execution. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('shows validate diagnostics in tick, explain and doctor while preventing command effects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'am-preflight-cli-'));
  const monitorsDir = path.join(root, 'monitors');
  const dir = path.join(monitorsDir, 'invalid');
  const marker = path.join(root, 'ran');
  mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../dist/index.cjs'), ...args],
      {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          AGENTMONITORS_DB: path.join(root, 'state.db'),
          AGENTMONITORS_SOCKET: path.join(root, 'missing.sock'),
        },
        timeout: 10000,
      },
    );
  const write = (strategy: string) =>
    writeFileSync(
      path.join(dir, 'MONITOR.md'),
      `---\nname: Invalid\nwatch:\n  type: command-poll\n  command: ${JSON.stringify(['sh', '-c', `echo ran >> "${marker}"; echo '{"items":[]}'`])}\n  change-detection:\n    strategy: ${strategy}\n    collection:\n      path: .items\n      key: .id\nurgency: normal\n---\nHandle it.\n`,
    );
  try {
    write('text-diff');
    const validation = run('validate', monitorsDir, '--format', 'json');
    expect(validation.status).toBe(1);
    const diagnostic: string = JSON.parse(validation.stdout).errors[0].error;
    expect(diagnostic).toContain(
      'change-detection.collection requires strategy: json-diff',
    );
    const tick = run(
      'daemon',
      'once',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    expect(tick.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(tick.stdout).skippedMonitors).toEqual([
      { monitorId: 'invalid', validationError: diagnostic },
    ]);
    const text = run('daemon', 'once', monitorsDir, '--workspace', root);
    expect(text.stdout).toContain(`invalid: skipped — ${diagnostic}`);
    expect(text.stdout).not.toContain('not yet due');
    const explain = run(
      'monitor',
      'explain',
      'invalid',
      '--dir',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    expect(JSON.parse(explain.stdout).stages[0].reason).toBe(
      `Monitor definition is invalid: ${diagnostic}`,
    );
    const doctor = run(
      'doctor',
      '--dir',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    expect(JSON.parse(doctor.stdout).monitors[0].validationError).toBe(
      diagnostic,
    );
    // Removing the invalid collection strategy proves the command marker works.
    write('json-diff');
    expect(run('daemon', 'once', monitorsDir, '--workspace', root).status).toBe(
      0,
    );
    expect(existsSync(marker)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A rejected interval must be diagnosable without entering duration scheduling. */
it('keeps malformed-duration diagnostics consistent across validate, tick, explain and doctor', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'am-duration-cli-'));
  const monitorsDir = path.join(root, 'monitors');
  for (const id of ['aaa-invalid', 'zzz-healthy']) {
    const dir = path.join(monitorsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'MONITOR.md'),
      `---\nname: ${id}\nwatch:\n  type: file-fingerprint\n  globs: ['watched.txt']\n  interval: ${id === 'aaa-invalid' ? 'bad' : '1s'}\nurgency: normal\n---\nHandle it.\n`,
    );
  }
  writeFileSync(path.join(root, 'watched.txt'), 'baseline');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../dist/index.cjs'), ...args],
      {
        encoding: 'utf8',
        cwd: root,
        timeout: 10000,
        env: {
          ...process.env,
          AGENTMONITORS_DB: path.join(root, 'state.db'),
          AGENTMONITORS_SOCKET: path.join(root, 'missing.sock'),
        },
      },
    );
  try {
    const validation = run('validate', monitorsDir, '--format', 'json');
    expect(validation.status).toBe(1);
    const diagnostic: string = JSON.parse(validation.stdout).errors[0].error;
    expect(diagnostic).toContain('scope/interval');
    const tick = run(
      'daemon',
      'once',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    expect(tick.status).toBe(0);
    expect(JSON.parse(tick.stdout)).toMatchObject({
      evaluatedMonitors: ['zzz-healthy'],
      skippedMonitors: [
        { monitorId: 'aaa-invalid', validationError: diagnostic },
      ],
    });
    const explain = run(
      'monitor',
      'explain',
      'aaa-invalid',
      '--dir',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    expect(explain.status).toBe(0);
    expect(JSON.parse(explain.stdout).stages[0].reason).toBe(
      `Monitor definition is invalid: ${diagnostic}`,
    );
    const doctor = run(
      'doctor',
      '--dir',
      monitorsDir,
      '--workspace',
      root,
      '--format',
      'json',
    );
    const report = JSON.parse(doctor.stdout);
    expect(report.monitors).toHaveLength(2);
    expect(
      report.monitors.find(
        (monitor: { id: string }) => monitor.id === 'aaa-invalid',
      ),
    ).toMatchObject({
      valid: false,
      validationError: diagnostic,
      nextDueAt: null,
    });
    expect(
      report.monitors.find(
        (monitor: { id: string }) => monitor.id === 'zzz-healthy',
      ),
    ).toMatchObject({ valid: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
