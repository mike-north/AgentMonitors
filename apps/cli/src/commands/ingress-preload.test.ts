/**
 * The interruption inventory must reject durable work outside its classified
 * admission paths. Tiny child runtimes test the preload's guard independently
 * of the recovery matrix, including asynchronous tick and watcher continuations.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

/** Run the real preload with the same dispatch seam and SQLite driver as the CLI. */
function probe(
  boundary: 'tick' | 'consumeWatch',
  body: string,
  ingress = "db.prepare('INSERT INTO probe VALUES (?)').run('classified');",
): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ingress-guard-')));
  const entry = path.join(root, 'probe.cjs');
  writeFileSync(
    entry,
    `
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE probe (value TEXT); CREATE TABLE object_event_suppressions (expires_at INTEGER)');
    process.send = value => console.log(JSON.stringify(value));
    class SourceRegistry { register() {} }
    class AgentMonitorRuntime {
      ingest() { ${ingress} }
      flushHeldNotifyWork() {}
      drainMaterializationRetries() {}
      reconcileNotifyEdit() {}
      watchMonitors() {}
      async tick() { ${boundary === 'tick' ? body : ''} }
      async consumeWatch() { ${boundary === 'consumeWatch' ? body : ''} }
    }
    const program2 = { async parseAsync() {
      process.emit('message', { stage: 'accept', trace: true });
      try { await new AgentMonitorRuntime().${boundary}(); }
      catch (error) { console.log(String(error)); }
      finally { db.close(); }
    }};
    program2.parseAsync();
  `,
  );
  try {
    return execFileSync(
      process.execPath,
      [
        '--import',
        path.join(import.meta.dirname, 'fixtures/ingress-preload.mjs'),
        entry,
      ],
      {
        env: {
          ...process.env,
          NODE_PATH: path.resolve(import.meta.dirname, '../../node_modules'),
          INGRESS_TEST_NOW: '1767225602000',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const boundary of ['tick', 'consumeWatch'] as const) {
  it(`names SQL and call site for an unclassified ${boundary} write after await`, () => {
    const output = probe(
      boundary,
      `
      await Promise.resolve();
      db.prepare('INSERT INTO probe VALUES (?)').run('unexpected');
    `,
    );
    expect(output).toContain('Unclassified ingress write');
    expect(output).toContain('INSERT INTO probe VALUES (?)');
    expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
  });

  it(`discovers classified writes within the full ${boundary} lifecycle`, () => {
    const output = probe(boundary, 'await Promise.resolve(); this.ingest();');
    expect(output).toContain('"kind":"write"');
    expect(output).not.toContain('Unclassified ingress write');
  });
}

it('rejects direct SQL writes that bypass prepared statements', () => {
  const output = probe(
    'tick',
    'db.exec("INSERT INTO probe VALUES (\'unexpected\')");',
  );
  expect(output).toContain('Unclassified ingress write');
  expect(output).toContain('INSERT INTO probe');
  expect(output).toContain('AgentMonitorRuntime.tick');
});

it('names the exact expired-suppression maintenance exclusion', () => {
  const output = probe(
    'tick',
    `
    this.purgeExpiredObjectSuppressions = function purgeExpiredObjectSuppressions() {
      db.prepare('delete from "object_event_suppressions" where "object_event_suppressions"."expires_at" <= ?').run(0);
    };
    this.purgeExpiredObjectSuppressions();
  `,
  );
  expect(output).toContain('"exclusion":"expired-suppression-maintenance"');
  expect(output).not.toContain('Unclassified ingress write');
});

it('refuses deferred iterator writes rather than claiming a pre-execution kill point', () => {
  const output = probe(
    'tick',
    'this.ingest();',
    `
    [...db.prepare('INSERT INTO probe VALUES (?) RETURNING value').iterate('deferred')];
  `,
  );
  expect(output).toContain('Unclassified ingress write');
  expect(output).toContain('INSERT INTO probe VALUES (?) RETURNING value');
  expect(output).toContain('AgentMonitorRuntime.ingest');
});
