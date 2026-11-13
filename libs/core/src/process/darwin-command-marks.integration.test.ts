/** Kernel ownership evidence must never confuse diagnostic arguments with envp. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { readCommandMarks } from './command-process-marks.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

it.skipIf(process.platform !== 'darwin')(
  'reads only envp with Homebrew absent, including empty and marker-shaped arguments',
  async () => {
    const nonce = '00000000-0000-4000-8000-000000000618';
    const pids: number[] = [];
    for (const marked of [false, true]) {
      const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
      delete env['AGENTMONITORS_COMMAND_LIFE'];
      if (marked) env['AGENTMONITORS_COMMAND_LIFE'] = nonce;
      const child = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(()=>{},1000);process.send("ready")',
          '',
          `AGENTMONITORS_COMMAND_LIFE=${nonce}`,
          '',
        ],
        {
          cwd: process.env.TMPDIR,
          env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      children.push(child);
      await once(child, 'message');
      if (child.pid === undefined) throw new Error('Missing owned fixture PID');
      pids.push(child.pid);
    }
    const original = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const reading = await readCommandMarks(pids);
      expect(reading.supported).toBe(true);
      if (!reading.supported) throw new Error(reading.reason);
      expect([...reading.marks]).toEqual([[pids[1], nonce]]);
      expect(reading.unreadable).toEqual([]);
    } finally {
      process.env.PATH = original;
    }
  },
);
