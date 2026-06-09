import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspacePaths } from './workspace-paths.js';

describe('workspacePaths', () => {
  it('derives a stable per-workspace socket + db under the data dir', () => {
    const a = workspacePaths('/Users/me/projects/foo');
    const b = workspacePaths('/Users/me/projects/foo');
    const c = workspacePaths('/Users/me/projects/bar');

    expect(a).toEqual(b); // stable for the same workspace
    expect(a.socket).not.toBe(c.socket); // distinct per workspace
    expect(a.db.endsWith(path.join('inbox.db'))).toBe(true);
    expect(a.socket.endsWith('.sock')).toBe(true);
    // Assert the structural shape, not a homedir prefix — the data root honors
    // XDG_DATA_HOME, which is set in many CI environments and would break a
    // `startsWith(os.homedir())` assertion.
    expect(a.dir).toContain(path.join('agentmonitors', 'workspaces'));
  });

  it('honours XDG_DATA_HOME when set', () => {
    const xdgDir = mkdtempSync(path.join(tmpdir(), 'agentmon-xdg-'));
    const savedXdg = process.env['XDG_DATA_HOME'];
    try {
      process.env['XDG_DATA_HOME'] = xdgDir;
      const p = workspacePaths('/Users/me/projects/xdg-test');
      expect(p.dir.startsWith(xdgDir)).toBe(true);
      expect(p.dir).toContain(path.join('agentmonitors', 'workspaces'));
    } finally {
      if (savedXdg === undefined) {
        delete process.env['XDG_DATA_HOME'];
      } else {
        process.env['XDG_DATA_HOME'] = savedXdg;
      }
      rmSync(xdgDir, { recursive: true, force: true });
    }
  });

  it('produces a valid .sock path for a workspace path containing a space', () => {
    const p = workspacePaths('/Users/me/my projects/spaced repo');
    expect(p.socket.endsWith('.sock')).toBe(true);
    // The hash is derived from the path, so spaces/unicode must not break it.
    expect(p.dir).toContain(path.join('agentmonitors', 'workspaces'));
  });

  it('produces a valid .sock path for a workspace path containing unicode', () => {
    const p = workspacePaths('/Users/me/プロジェクト/監視');
    expect(p.socket.endsWith('.sock')).toBe(true);
    expect(p.dir).toContain(path.join('agentmonitors', 'workspaces'));
  });
});
