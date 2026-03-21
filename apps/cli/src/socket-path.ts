import path from 'node:path';
import { homedir } from 'node:os';

export function resolveSocketPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env['AGENTMONITORS_SOCKET']) {
    return process.env['AGENTMONITORS_SOCKET'];
  }
  return path.join(
    homedir(),
    '.local',
    'share',
    'agentmonitors',
    'agentmonitors.sock',
  );
}
