/**
 * Unit tests for the Claude Code hook stdin reader.
 *
 * stdin is a process trust boundary, so the reader must (a) never hang on a
 * missing/empty stream and (b) accept ONLY the expected string fields — a
 * non-string `session_id` must not pass through.
 *
 * @see https://code.claude.com/docs/en/hooks.md (Hook Input)
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { readHookPayload } from './hook-payload.js';

const realStdin = process.stdin;

function setStdin(value: NodeJS.ReadStream): void {
  Object.defineProperty(process, 'stdin', { value, configurable: true });
}

/** A piped (non-TTY) stdin that yields `content` then ends. */
function pipedStdin(content: string): NodeJS.ReadStream {
  const stream = Readable.from([content]) as unknown as NodeJS.ReadStream;
  stream.isTTY = false;
  return stream;
}

/**
 * A TTY stdin (interactive — no piped payload). `readHookPayload` checks
 * `isTTY` and returns before touching the stream, so a minimal stub suffices.
 */
function ttyStdin(): NodeJS.ReadStream {
  return { isTTY: true } as unknown as NodeJS.ReadStream;
}

afterEach(() => {
  setStdin(realStdin);
});

describe('readHookPayload', () => {
  it('returns the expected string fields from a valid CC payload', async () => {
    setStdin(
      pipedStdin(
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/ws',
          // extra fields the CLI does not consume are ignored
          transcript_path: '/t.jsonl',
          tool_name: 'Bash',
        }),
      ),
    );
    await expect(readHookPayload()).resolves.toEqual({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/ws',
    });
  });

  it('drops a non-string session_id (trust-boundary guard)', async () => {
    // A non-string session_id must NOT pass through as a truthy value — it would
    // collapse hook-state paths and risk session collisions.
    setStdin(pipedStdin(JSON.stringify({ session_id: 123, cwd: '/ws' })));
    const payload = await readHookPayload();
    expect(payload.session_id).toBeUndefined();
    expect(payload.cwd).toBe('/ws');
  });

  it('drops non-string hook_event_name and cwd', async () => {
    setStdin(
      pipedStdin(
        JSON.stringify({ session_id: 's1', hook_event_name: 5, cwd: false }),
      ),
    );
    await expect(readHookPayload()).resolves.toEqual({ session_id: 's1' });
  });

  it('returns {} for a TTY stdin (no piped payload) without hanging', async () => {
    setStdin(ttyStdin());
    await expect(readHookPayload()).resolves.toEqual({});
  });

  it('returns {} for empty stdin', async () => {
    setStdin(pipedStdin(''));
    await expect(readHookPayload()).resolves.toEqual({});
  });

  it('returns {} for unparseable stdin', async () => {
    setStdin(pipedStdin('not json {'));
    await expect(readHookPayload()).resolves.toEqual({});
  });

  it('returns {} for valid JSON that is not an object (array / scalar)', async () => {
    setStdin(pipedStdin('[1, 2, 3]'));
    await expect(readHookPayload()).resolves.toEqual({});
  });
});
