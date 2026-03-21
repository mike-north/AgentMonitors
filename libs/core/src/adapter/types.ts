import type {
  AgentLifecycleEvent,
  OpenSessionInput,
  SessionHookState,
} from '../runtime/types.js';

export interface AgentRuntimeAdapter {
  readonly name: string;
  readonly hookEventMap: Record<AgentLifecycleEvent, string>;
  defaultHookStatePath(input: {
    workspacePath?: string;
    hostSessionId: string;
  }): string;
  createSessionInput(input: {
    hostSessionId: string;
    agentIdentity?: string;
    role?: 'lead' | 'subagent';
    workspacePath?: string;
    hookStatePath?: string;
  }): OpenSessionInput;
  materializeHookState(state: SessionHookState): Record<string, unknown>;
}
