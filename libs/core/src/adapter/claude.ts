import path from 'node:path';
import type { AgentRuntimeAdapter } from './types.js';

function safeSessionPathSegment(hostSessionId: string): string {
  const encoded = Array.from(hostSessionId, (char) => {
    if (/^[A-Za-z0-9_-]$/.test(char)) {
      return char;
    }

    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return '_';
    }

    return `~${codePoint.toString(16).padStart(2, '0')}`;
  }).join('');

  if (encoded.length === 0) {
    return '_empty';
  }

  if (encoded === '.' || encoded === '..') {
    return encoded.replaceAll('.', '~2e');
  }

  return encoded;
}

export const claudeCodeAdapter: AgentRuntimeAdapter = {
  name: 'claude-code',
  hookEventMap: {
    'session-opened': 'SessionStart',
    'session-dormant': 'SessionEnd',
    'turn-interruptible': 'PreToolUse',
    'turn-ended': 'Stop',
    'turn-idle': 'TeammateIdle',
    'pre-compact': 'PreCompact',
    'post-compact': 'PostCompact',
  },
  defaultHookStatePath(input) {
    const base = input.workspacePath ?? process.cwd();
    const sessionDir = safeSessionPathSegment(input.hostSessionId);
    return path.join(
      base,
      '.agentmonitors',
      'sessions',
      sessionDir,
      'hook-state.json',
    );
  },
  createSessionInput(input) {
    const resolvedHookStatePath =
      input.hookStatePath ??
      this.defaultHookStatePath(
        input.workspacePath
          ? {
              workspacePath: input.workspacePath,
              hostSessionId: input.hostSessionId,
            }
          : { hostSessionId: input.hostSessionId },
      );
    return {
      adapter: 'claude-code',
      hostSessionId: input.hostSessionId,
      agentIdentity: input.agentIdentity ?? input.hostSessionId,
      role: input.role ?? 'lead',
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      hookStatePath: resolvedHookStatePath,
    };
  },
  materializeHookState(state) {
    return {
      sessionId: state.sessionId,
      updatedAt: state.updatedAt,
      unread: state.unread,
      hasPendingHigh: state.hasPendingHigh,
      hasPendingNormal: state.hasPendingNormal,
      hasPendingLow: state.hasPendingLow,
      latestHighTitles: state.latestHighTitles,
    };
  },
};
