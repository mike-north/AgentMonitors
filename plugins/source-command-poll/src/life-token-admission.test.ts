/** Admission must retain exactly the committed vnode or refuse before authored execution. */
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandProcessJournal } from '@agentmonitors/core';
import { createCommandPollSource } from './index.js';

/** Fault only the disposable launcher, never authored code or the test host. */
const injection = vi.hoisted(() => ({ prefix: '', captureFailure: false }));
vi.mock('./self-bound.js', async (original) => {
  const actual = await original<typeof import('./self-bound.js')>();
  return {
    ...actual,
    get LAUNCHER_PROGRAM() {
      return injection.prefix + actual.LAUNCHER_PROGRAM;
    },
  };
});
vi.mock('./open-file-limits.js', async (original) => {
  const actual = await original<typeof import('./open-file-limits.js')>();
  return {
    ...actual,
    inheritedOpenFileLimits: () => {
      if (injection.captureFailure)
        throw new Error('injected pre-spawn capture refusal');
      return actual.inheritedOpenFileLimits();
    },
  };
});
afterEach(() => {
  injection.prefix = '';
  injection.captureFailure = false;
});

/** Each private tuple and sentinel belongs exclusively to this test. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'am-token-'));
  const file = path.join(root, 'life');
  writeFileSync(file, 'private', { mode: 0o600 });
  const stat = statSync(file, { bigint: true });
  const token = {
    life: '00000000-0000-4000-8000-000000000626',
    path: realpathSync(file),
    device: String(stat.dev),
    inode: String(stat.ino),
  };
  const owner = {
    environment: async () => ({ AGENTMONITORS_COMMAND_LIFE: token.life }),
    lifeToken: () => token,
    spawned: () => {
      /* This admission fixture has no durable PID bookkeeping. */
    },
    exited: () => {
      /* Its live watchdog owns finite fixture cleanup. */
    },
  };
  return { root, token, owner };
}

it.skipIf(process.platform !== 'darwin')(
  'inherits the committed vnode across authored exec with FD_CLOEXEC cleared',
  async () => {
    const f = fixture();
    const source = createCommandPollSource(f.owner);
    const result = await source.observe(
      {
        command: [
          process.execPath,
          '-e',
          `
    const fs = require('node:fs');
    const expected = ${JSON.stringify(f.token)};
    let found = false;
    for (let fd = 3; fd < 128; fd++) {
      try { const st = fs.fstatSync(fd, {bigint:true}); if (String(st.dev) === expected.device && String(st.ino) === expected.inode) found = true; } catch {}
    }
    process.stdout.write(found ? 'retained' : 'missing');
  `,
        ],
        timeout: '3s',
      },
      { now: new Date() },
    );
    expect(result.nextState).toMatchObject({
      health: 'ok',
      stdout: 'retained',
      exitCode: 0,
    });
  },
);

it
  .skipIf(process.platform !== 'darwin')
  .each(['missing', 'identity', 'set-flags', 'read-flags', 'still-cloexec'])(
  'preserves the baseline and refuses authored exec on token %s failure',
  async (fault) => {
    const f = fixture();
    if (fault === 'missing') f.token.path += '.missing';
    if (fault === 'identity')
      f.token.inode = String(BigInt(f.token.inode) + 1n);
    if (['set-flags', 'read-flags', 'still-cloexec'].includes(fault)) {
      injection.prefix = `
        const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.endsWith('/load.cjs')) return loaded;
          return {...loaded, load(...loadArgs) {
            const library = loaded.load(...loadArgs);
            return {...library, func(declaration) {
              const native = library.func(declaration);
              if (!declaration.includes(' fcntl(')) return native;
              return (fd, cmd, ...rest) => {
                if (fd > 2 && cmd === 2 && ${JSON.stringify(fault)} === 'set-flags') return -1;
                if (fd > 2 && cmd === 1 && ${JSON.stringify(fault)} === 'read-flags') return -1;
                if (fd > 2 && cmd === 1 && ${JSON.stringify(fault)} === 'still-cloexec') return 1;
                return native(fd, cmd, ...rest);
              };
            }};
          }};
        };
      `;
    }
    const sentinel = path.join(f.root, 'ran');
    const previousState = {
      stdout: 'baseline',
      exitCode: 7,
      truncated: false,
      health: 'ok',
      baselined: true,
    };
    const result = await createCommandPollSource(f.owner).observe(
      {
        command: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`,
        ],
        timeout: '3s',
      },
      { now: new Date(), previousState },
    );
    expect(existsSync(sentinel)).toBe(false);
    expect(result.nextState).toMatchObject({
      ...previousState,
      health: 'failing',
    });
    expect(result.observations[0]?.payload).toMatchObject({
      error: expect.stringMatching(/life token/i),
    });
  },
);

it.skipIf(process.platform !== 'darwin')(
  'commits the life nonce and vnode before a resource capture refusal',
  async () => {
    const f = fixture();
    const db = path.join(f.root, 'db');
    const journal = CommandProcessJournal.open(db, f.root);
    try {
      injection.captureFailure = true;
      const result = await createCommandPollSource(journal).observe(
        { command: ['/bin/echo', 'must not run'], timeout: '3s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'failing' });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining('injected pre-spawn capture refusal'),
      });
      const token = journal.lifeToken();
      expect(token).toBeDefined();
      if (!token) throw new Error('Missing pre-spawn life token');
      expect(existsSync(token.path)).toBe(true);
      expect(existsSync(`${db}.commands.sqlite`)).toBe(true);
    } finally {
      journal.close();
    }
  },
);
