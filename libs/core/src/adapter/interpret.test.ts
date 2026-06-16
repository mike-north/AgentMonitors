/**
 * Tests for the concrete {@link createClaudeInterpretAdapter} — the host-specific
 * `claude -p` invocation that 002 §1.1.8 / 006 §2.1 require to live behind the
 * adapter boundary, NEVER in the runtime core.
 *
 * A real model is never invoked: the adapter is pointed at a deterministic fake
 * CLI shim (a tiny Node script) so the argv/stdout contract is exercised without
 * any credentials or network egress (C45).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.8
 * @see ../../../../docs/specs/006-agent-integration.md §2.1
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeInterpretAdapter } from './interpret.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write an executable Node shim that emulates an AI CLI: it echoes a canned
 * response for `process.argv[3]` (the prompt passed after `-p`). Returns its path.
 */
function writeShim(rootDir: string, body: string): string {
  const shimPath = path.join(rootDir, 'fake-ai');
  writeFileSync(shimPath, `#!/usr/bin/env node\n${body}\n`, 'utf-8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

describe('createClaudeInterpretAdapter (002 §1.1.8 / 006 §2.1)', () => {
  it('parses a DELIVER: response into a deliver decision with the digest', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-ai-shim-'));
    tempDirs.push(rootDir);
    const shim = writeShim(
      rootDir,
      `process.stdout.write('DELIVER: build went red on main');`,
    );
    const adapter = createClaudeInterpretAdapter({ command: shim });

    const result = await adapter.interpret({
      delta: '- ok\n+ FAILED',
      criteria: 'tell me about failures',
      monitorId: 'ci-status',
    });

    expect(result).toEqual({
      decision: 'deliver',
      digest: 'build went red on main',
    });
  });

  it('parses a SUPPRESS: response into a suppress decision with the reason', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-ai-shim-'));
    tempDirs.push(rootDir);
    const shim = writeShim(
      rootDir,
      `process.stdout.write('SUPPRESS: only a timestamp changed');`,
    );
    const adapter = createClaudeInterpretAdapter({ command: shim });

    const result = await adapter.interpret({
      delta: '- 10:00\n+ 10:01',
      monitorId: 'ci-status',
    });

    expect(result).toEqual({
      decision: 'suppress',
      reason: 'only a timestamp changed',
    });
  });

  it('receives the delta in its prompt via argv (no shell interpolation)', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-ai-shim-'));
    tempDirs.push(rootDir);
    // The shim asserts it was invoked as `<shim> -p <prompt>` and that the
    // prompt embeds the delta verbatim, then echoes a deliver response.
    const shim = writeShim(
      rootDir,
      [
        `const flag = process.argv[2];`,
        `const prompt = process.argv[3] ?? '';`,
        `if (flag !== '-p') { process.stderr.write('bad flag'); process.exit(2); }`,
        `if (!prompt.includes('$(rm -rf /)')) { process.stderr.write('delta missing'); process.exit(3); }`,
        `process.stdout.write('DELIVER: saw the delta');`,
      ].join('\n'),
    );
    const adapter = createClaudeInterpretAdapter({ command: shim });

    // A shell-metacharacter payload must reach the tool literally, proving argv
    // execution (never a shell).
    const result = await adapter.interpret({
      delta: 'value is $(rm -rf /)',
      monitorId: 'm',
    });

    expect(result).toEqual({ decision: 'deliver', digest: 'saw the delta' });
  });

  it('rejects when the tool is not installed (best-effort failure path)', async () => {
    const adapter = createClaudeInterpretAdapter({
      command: '/nonexistent/definitely-not-a-real-ai-cli',
    });

    await expect(
      adapter.interpret({ delta: 'x', monitorId: 'm' }),
    ).rejects.toThrow();
  });
});
