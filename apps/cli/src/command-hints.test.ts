/**
 * Tests for {@link appendErrorHints} — the additive Commander error-hint helper
 * used for the manual/no-docs CLI-path papercuts (issue #420 P2/P5).
 *
 * @see ./command-hints.ts
 * @see ../../../docs/specs/005-cli-reference.md §11 (events), §10 (monitor history)
 */
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { appendErrorHints } from './command-hints.js';

/** Capture everything written to `process.stderr` while `fn` runs. */
function collectStderr(fn: () => void): string {
  let out = '';
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

/**
 * A leaf command that errors on a missing required option. `exitOverride`
 * turns Commander's `process.exit` into a throw so the test can drive parsing
 * without killing the runner; the thrown CommanderError is expected.
 */
function makeCommand(hintPatterns: Parameters<typeof appendErrorHints>[1]): {
  parseMissing: () => void;
} {
  const program = new Command();
  const cmd = program
    .command('list')
    .requiredOption('--session <id>', 'AgentMon session id (required)')
    .action(() => {
      /* not reached in these tests */
    });
  appendErrorHints(cmd, hintPatterns);
  cmd.exitOverride();
  return {
    parseMissing: () => {
      program.parse(['node', 'cli', 'list']);
    },
  };
}

describe('appendErrorHints', () => {
  const sessionHint = {
    pattern: /required option '--session/,
    hint: 'Run `agentmonitors session list` to find a session id.',
  };

  it('appends the hint line after a matching Commander error', () => {
    const { parseMissing } = makeCommand([sessionHint]);
    const stderr = collectStderr(() => {
      expect(parseMissing).toThrow();
    });
    // The original error line is preserved verbatim...
    expect(stderr).toContain(
      "error: required option '--session <id>' not specified",
    );
    // ...and the hint is appended on its own line.
    expect(stderr).toContain(
      'Run `agentmonitors session list` to find a session id.',
    );
    // The hint follows the error, and each is newline-terminated.
    const errIdx = stderr.indexOf('error:');
    const hintIdx = stderr.indexOf('Run `agentmonitors');
    expect(hintIdx).toBeGreaterThan(errIdx);
    expect(stderr.endsWith('\n')).toBe(true);
  });

  it('does not append a hint whose pattern does not match the error', () => {
    const { parseMissing } = makeCommand([
      { pattern: /unknown option '--dir'/, hint: 'try --workspace' },
    ]);
    const stderr = collectStderr(() => {
      expect(parseMissing).toThrow();
    });
    expect(stderr).toContain(
      "error: required option '--session <id>' not specified",
    );
    expect(stderr).not.toContain('try --workspace');
  });

  it('supplies the missing trailing newline for a hint without one', () => {
    const { parseMissing } = makeCommand([
      { pattern: /required option '--session/, hint: 'no-newline-hint' },
    ]);
    const stderr = collectStderr(() => {
      expect(parseMissing).toThrow();
    });
    expect(stderr).toContain('no-newline-hint\n');
  });
});
