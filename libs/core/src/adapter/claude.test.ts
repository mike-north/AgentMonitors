import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claude.js';

describe('claudeCodeAdapter.defaultHookStatePath', () => {
  it('keeps ordinary session ids readable', () => {
    const workspacePath = '/tmp/workspace';

    expect(
      claudeCodeAdapter.defaultHookStatePath({
        workspacePath,
        hostSessionId: 'session_123-abc',
      }),
    ).toBe(
      path.join(
        workspacePath,
        '.agentmonitors',
        'sessions',
        'session_123-abc',
        'hook-state.json',
      ),
    );
  });

  it('prevents parent-directory traversal via hostSessionId', () => {
    const workspacePath = '/tmp/workspace';
    const hookStatePath = claudeCodeAdapter.defaultHookStatePath({
      workspacePath,
      hostSessionId: '../../outside',
    });

    expect(hookStatePath).toBe(
      path.join(
        workspacePath,
        '.agentmonitors',
        'sessions',
        '~2e~2e~2f~2e~2e~2foutside',
        'hook-state.json',
      ),
    );
  });

  it('prevents absolute-path injection via hostSessionId', () => {
    const workspacePath = '/tmp/workspace';
    const hookStatePath = claudeCodeAdapter.defaultHookStatePath({
      workspacePath,
      hostSessionId: '/var/tmp/escape',
    });

    expect(hookStatePath).toBe(
      path.join(
        workspacePath,
        '.agentmonitors',
        'sessions',
        '~2fvar~2ftmp~2fescape',
        'hook-state.json',
      ),
    );
  });
});
