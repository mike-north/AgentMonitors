import path from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the SQLite database path.
 *
 * Priority:
 * 1. AGENTMONITORS_DB environment variable
 * 2. --db CLI flag (passed via commander's parent options)
 * 3. Default: ~/.local/share/agentmonitors/inbox.db
 */
export function resolveDbPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env['AGENTMONITORS_DB']) return process.env['AGENTMONITORS_DB'];
  return path.join(homedir(), '.local', 'share', 'agentmonitors', 'inbox.db');
}
