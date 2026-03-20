import path from 'node:path';
import type { AgentRuntimeAdapter } from './types.js';

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
    return path.join(
      base,
      '.agentmonitors',
      'sessions',
      input.hostSessionId,
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
