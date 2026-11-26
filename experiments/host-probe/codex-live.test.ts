import { describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createBoundClient, redactId, hookOutput, hookSighting, validateWorkspace, markerReceipt } from './codex-live.mjs';

describe('live probe delivery boundary', () => {
  it('permits delivery only to threads created by this client in this run', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'owned' } }
      : {});
    const client = createBoundClient(rpc);
    for (const method of ['turn/start', 'turn/steer', 'thread/inject_items']) {
      await expect(client.call(method, { threadId: 'foreign' })).rejects.toThrow();
    }
    expect(rpc).not.toHaveBeenCalled();
    await client.startThread({});
    await client.call('turn/start', { threadId: 'owned', input: [] });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not accept a claimed identity from a failed or malformed start', async () => {
    const client = createBoundClient(async () => ({ thread: {} }));
    await expect(client.startThread({})).rejects.toThrow();
    await expect(client.call('turn/steer', { threadId: 'foreign' })).rejects.toThrow();
  });

  it('rejects methods outside the delivery set even for a created thread', async () => {
    const rpc = vi.fn(async () => ({ thread: { id: 'owned' } }));
    const client = createBoundClient(rpc);
    await client.startThread({});
    await expect(client.call('thread/delete', { threadId: 'owned' })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('requires an empty physical temporary workspace', () => {
    const temporaryRoot = realpathSync('/tmp');
    const candidate = join(temporaryRoot, 'generated-workspace');
    expect(() => validateWorkspace(candidate, [])).not.toThrow();
    expect(() => validateWorkspace(candidate, ['.codex'])).toThrow();
    expect(() => validateWorkspace(`${temporaryRoot}-other`, [])).toThrow();
  });

  it('redacts identities consistently without retaining the input', () => {
    expect(redactId('same')).toBe(redactId('same'));
    expect(redactId('same')).not.toBe(redactId('different'));
    expect(redactId('same')).not.toContain('same');
  });

  it('never persists incidental text from a model answer', () => {
    const marker = 'PROBE_UNIQUE';
    const incidentalPath = join(realpathSync('/tmp'), 'incidental-path');
    const incidentalId = 'sensitive-identity-123';
    const receipt = markerReceipt(marker, 'turn-123', [`${incidentalPath} ${incidentalId} ${marker}`]);
    expect(receipt).toEqual({ marker, present: true, turnId: redactId('turn-123') });
    expect(JSON.stringify(receipt)).not.toContain(incidentalPath);
    expect(JSON.stringify(receipt)).not.toContain(incidentalId);
  });
});

describe('hook evidence', () => {
  it('emits valid JSON for stop and compaction while retaining a distinct marker', () => {
    for (const event of ['Stop', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      expect(JSON.parse(hookOutput(event, 'context'))).toEqual({ continue: true, systemMessage: `PROBE_${event.toUpperCase()}_CONTEXT_682` });
    }
    expect(JSON.parse(hookOutput('Stop', 'plain'))).toEqual({ continue: true });
  });

  it('includes the supplied run nonce in every emitted marker', () => {
    expect(hookOutput('SessionStart', 'plain', 'RUNX9')).toBe('PROBE_SESSIONSTART_PLAIN_RUNX9');
    expect(hookOutput('Stop', 'context', 'RUNX9')).toContain('PROBE_STOP_CONTEXT_RUNX9');
  });

  it('records field names and hashed identities without retaining payload values', () => {
    const result = hookSighting({ session_id: 'private-id', cwd: join(realpathSync('/tmp'), 'generated-workspace'), hook_event_name: 'Stop', turn_id: 'turn', secret: 'private' }, 'context', { CODEX_CI: 'secret-value', OTHER: 'secret' });
    expect(result.keys).toEqual(['cwd', 'hook_event_name', 'secret', 'session_id', 'turn_id']);
    expect(result.sessionId).toBe(redactId('private-id'));
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.codexEnvKeys).toEqual(['CODEX_CI']);
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.outputType).toBe('common-json-system-message');
    expect(hookSighting({ hook_event_name: 'Stop' }, 'plain').outputType).toBe('common-json-continue');
    expect(hookSighting({ hook_event_name: 'SessionStart' }, 'plain').outputType).toBe('plain-text');
    expect(hookSighting({ hook_event_name: 'PostToolUse' }, 'context').outputType).toBe('hook-specific-additional-context-json');
  });
});
