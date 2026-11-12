/** Script files share subprocess capacity; the actual suite must schedule them serially. */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { runJqTestChild } from './run-jq-test-child.mjs';

const root = resolve(import.meta.dirname, '..');

it('runs actual configured script files without overlapping an owned subprocess-capacity lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'script-scheduling-'));
  const events = join(dir, 'events.jsonl');
  const lease = join(dir, 'subprocess-capacity');
  try {
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    // Inherit the real scheduling policy and change only the fixture file set.
    // Two requested workers make removal of serial scheduling observable even
    // on a host whose default worker count would otherwise be one.
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      `import base from ${JSON.stringify(pathToFileURL(join(root, 'scripts/vitest.config.ts')).href)};export default {...base,root:${JSON.stringify(dir)},test:{...base.test,include:['left.test.ts','right.test.ts']}};`,
    );
    for (const name of ['left', 'right']) {
      // Real worker processes contend for a single filesystem lease. Holding it
      // briefly models a subprocess-heavy file; an overlapping file must fail,
      // rather than a test asserting a configuration property by inspection.
      writeFileSync(
        join(dir, `${name}.test.ts`),
        `import {it} from 'vitest';import {mkdirSync,rmSync,appendFileSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';it('owns ${name}',async()=>{let acquired=false;const log=(kind)=>appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,name:${JSON.stringify(name)},pid:process.pid})+'\\n');try{mkdirSync(${JSON.stringify(lease)});acquired=true;log('acquired');await setTimeout(900);}catch(error){log('overlap');throw error;}finally{if(acquired){log('released');rmSync(${JSON.stringify(lease)},{recursive:true});}}});`,
      );
    }
    const result = await runJqTestChild(
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(dir, 'vitest.config.ts'),
        '--maxWorkers=2',
      ],
      { cwd: dir, env: process.env, timeout: 5_000 },
    );
    const evidence = result.stdout + result.stderr;
    expect(result.error, evidence).toBeUndefined();
    expect(result.status, evidence).toBe(0);
    const entries: { kind: string; name: string; pid: number }[] = readFileSync(
      events,
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      entries.map((entry) => entry.kind),
      evidence,
    ).toEqual(['acquired', 'released', 'acquired', 'released']);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    expect(entries[0]?.name).toBe(entries[1]?.name);
    expect(entries[2]?.name).toBe(entries[3]?.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 8_000);
