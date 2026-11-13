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
  setup = '',
  inspectDurability = false,
  cleanup = '',
): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ingress-guard-')));
  const entry = path.join(root, 'probe.cjs');
  writeFileSync(
    entry,
    `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(path.join(root, 'probe.db'))});
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE probe (value TEXT); CREATE TABLE object_event_suppressions (expires_at INTEGER)');
    ${setup}
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
      finally {
        // A refused writable cursor stays untouched until ownership has ended.
        ${cleanup}
        db.close();
        ${
          inspectDurability
            ? `
        // A fresh connection distinguishes durable rows from a yielded RETURNING row.
        const reader = new Database(${JSON.stringify(path.join(root, 'probe.db'))}, { readonly: true });
        console.log('DURABLE_ROWS=' + JSON.stringify(reader.prepare('SELECT * FROM probe').all()));
        reader.close();`
            : ''
        }
      }
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

// Iterator ownership belongs to each advance/finalization, even when the cursor
// was created before lifecycle entry. Finalizing RETURNING completes its write.
for (const boundary of ['tick', 'consumeWatch'] as const) {
  for (const method of ['next', 'return'] as const) {
    it(`refuses a pre-existing writable iterator ${method} in ${boundary}`, () => {
      const sql = "INSERT INTO probe VALUES ('escaped') RETURNING value";
      const output = probe(
        boundary,
        `await Promise.resolve(); iterator.${method}();
         ${method === 'next' ? 'iterator.return();' : ''}`,
        undefined,
        `const iterator = db.prepare(${JSON.stringify(sql)}).iterate();`,
        true,
        'iterator.return();',
      );
      expect(output).toContain(`Unclassified ingress write: ${sql}`);
      expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
      expect(output).toContain('"kind":"unclassified-write"');
      expect(output).not.toContain('"kind":"write"');
      expect(output).toContain('DURABLE_ROWS=[]');
    });
  }

  it(`refuses writable iterator creation in ${boundary}`, () => {
    const sql = "INSERT INTO probe VALUES ('escaped') RETURNING value";
    const output = probe(
      boundary,
      `db.prepare(${JSON.stringify(sql)}).iterate();`,
      undefined,
      '',
      true,
    );
    expect(output).toContain(`Unclassified ingress write: ${sql}`);
    expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
    expect(output).toContain('DURABLE_ROWS=[]');
  });

  it(`preserves a pre-existing read iterator in ${boundary}`, () => {
    const output = probe(
      boundary,
      `console.log(JSON.stringify(iterator.next())); iterator.return();`,
      undefined,
      `db.prepare('INSERT INTO probe VALUES (?)').run('readable');
       const iterator = db.prepare('SELECT value FROM probe').iterate();`,
      true,
    );
    expect(output).toContain('"value":{"value":"readable"}');
    expect(output).not.toContain('Unclassified ingress write');
    expect(output).toContain('DURABLE_ROWS=[{"value":"readable"}]');
  });
}

it('preserves writable iterator execution outside a traced lifecycle', () => {
  const output = probe(
    'tick',
    '',
    undefined,
    `const iterator = db.prepare("INSERT INTO probe VALUES ('outside') RETURNING value").iterate();
     console.log(JSON.stringify(iterator.next())); iterator.return();`,
    true,
  );
  expect(output).toContain('"value":{"value":"outside"}');
  expect(output).not.toContain('Unclassified ingress write');
  expect(output).toContain('DURABLE_ROWS=[{"value":"outside"}]');
});

// PRAGMAs have both direct-SQL and native-driver entrypoints; neither may hide
// a durable write from the inventory, including checkpoints without assignments.
for (const boundary of ['tick', 'consumeWatch'] as const) {
  for (const operation of [
    {
      body: "db.exec('PRAGMA user_version = 610');",
      sql: 'PRAGMA user_version = 610',
    },
    {
      body: "db.pragma('user_version = 610');",
      sql: 'PRAGMA user_version = 610',
    },
    {
      body: "db.pragma('wal_checkpoint(TRUNCATE)');",
      sql: 'PRAGMA wal_checkpoint(TRUNCATE)',
    },
  ]) {
    it(`refuses ${operation.body} in ${boundary} with its exact SQL`, () => {
      const output = probe(boundary, operation.body);
      expect(output).toContain('Unclassified ingress write');
      expect(output).toContain(operation.sql);
      expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
    });
  }

  it(`allows read-only PRAGMA queries in ${boundary}`, () => {
    const output = probe(
      boundary,
      `
      db.exec('PRAGMA table_info(probe)');
      console.log(JSON.stringify({
        version: db.pragma('user_version', { simple: true }),
        columns: db.pragma('table_info(probe)').length,
      }));
    `,
    );
    // Machine-readable output keeps Node's forced numeric colors out of receipts.
    expect(output).toContain(JSON.stringify({ version: 0, columns: 1 }));
    expect(output).not.toContain('Unclassified ingress write');
  });
}

// One indexed table qualifies for optimize: SQLite can then persist ANALYZE
// statistics even though the outer statement advertises readonly=true.
for (const boundary of ['tick', 'consumeWatch'] as const) {
  for (const api of ['exec', 'pragma'] as const) {
    it(`refuses read-only-classified optimize through ${api} in ${boundary}`, () => {
      const output = probe(
        boundary,
        `
        console.log(JSON.stringify({ readonly: db.prepare('PRAGMA optimize').readonly }));
        db.${api}('${api === 'exec' ? 'PRAGMA optimize' : 'optimize'}');
        console.log(JSON.stringify({ stats: db.prepare('SELECT * FROM sqlite_stat1').all() }));
        `,
        undefined,
        "db.exec('CREATE INDEX probe_value ON probe(value); INSERT INTO probe VALUES (1),(2),(3)');",
      );
      expect(output).toContain('"readonly":true');
      expect(output).toContain('Unclassified ingress write: PRAGMA optimize');
      expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
    });
  }

  for (const sql of [
    '; /* empty statement */ PRAGMA analysis_limit',
    '; REINDEX',
    'PRAGMA analysis_limit',
    'PRAGMA auto_vacuum',
    'PRAGMA journal_mode',
    'PRAGMA unknown_ingress_query',
    'PRAGMA foreign_keys(OFF)',
    '/* boundary */ PRAGMA main."analysis_limit"',
    'ANALYZE',
    'VACUUM',
    'REINDEX',
    "ATTACH ':memory:' AS extra",
    'DETACH extra',
  ]) {
    it(`refuses direct maintenance or non-allowlisted SQL ${sql} in ${boundary}`, () => {
      const output = probe(
        boundary,
        `
        console.log(JSON.stringify({ readonly: db.prepare(${JSON.stringify(sql)}).readonly }));
        db.exec(${JSON.stringify(sql)});
        `,
        undefined,
        sql === 'DETACH extra' ? `db.exec("ATTACH ':memory:' AS extra");` : '',
      );
      if (sql === 'PRAGMA analysis_limit' || sql === 'REINDEX') {
        expect(output).toContain('"readonly":true');
      }
      expect(output).toContain(`Unclassified ingress write: ${sql}`);
      expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
    });
  }

  it(`preserves allowlisted queries and plain reads in ${boundary}`, () => {
    const output = probe(
      boundary,
      `
      db.exec('SELECT 1');
      for (const sql of [
        'table_info(probe)', 'table_xinfo(probe)', 'index_list(probe)',
        'index_info(probe_value)', 'index_xinfo(probe_value)', 'foreign_key_list(probe)',
        'user_version', 'schema_version', 'data_version', 'page_count', 'freelist_count',
        'page_size', 'foreign_keys', 'busy_timeout',
        'main."table_info"(probe)',
      ]) {
        db.exec('/* query */ PRAGMA ' + sql);
        db.pragma(sql);
      }
      console.log('ALLOWLIST_QUERIES_PASSED');
      `,
      undefined,
      "db.exec('CREATE INDEX probe_value ON probe(value)');",
    );
    expect(output).toContain('ALLOWLIST_QUERIES_PASSED');
    expect(output).not.toContain('Unclassified ingress write');
  });
}

// Prepared handles can predate lifecycle ownership; admission belongs to execution.
for (const boundary of ['tick', 'consumeWatch'] as const) {
  for (const method of ['run', 'get', 'all', 'iterate'] as const) {
    for (const preprepared of [false, true]) {
      it(`refuses prepared optimize ${method} in ${boundary}, preprepared=${String(preprepared)}`, () => {
        const execute = `statement.${method}()`;
        const output = probe(
          boundary,
          `${preprepared ? '' : "const statement = db.prepare('PRAGMA optimize');"}
           ${method === 'iterate' ? `[...${execute}]` : execute};`,
          undefined,
          `db.exec('CREATE INDEX probe_value ON probe(value); INSERT INTO probe VALUES (1),(2),(3)');
           ${preprepared ? "const statement = db.prepare('PRAGMA optimize');" : ''}`,
        );
        expect(output).toContain('Unclassified ingress write: PRAGMA optimize');
        expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
      });
    }
  }
  for (const api of ['exec', 'prepare'] as const) {
    it(`refuses table-valued optimize through ${api} in ${boundary}`, () => {
      const output = probe(
        boundary,
        `db.${api}('SELECT * FROM pragma_optimize')${api === 'prepare' ? '.all()' : ''};`,
        undefined,
        "db.exec('CREATE INDEX probe_value ON probe(value); INSERT INTO probe VALUES (1),(2),(3)');",
      );
      expect(output).toContain(
        'Unclassified ingress write: SELECT * FROM pragma_optimize',
      );
      expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
    });
  }

  // A user function simulates an unknown native effect without a SQL write verb
  // or PRAGMA name. Changing existing bytes also defeats size-only WAL probes.
  for (const target of ['main', 'wal'] as const) {
    for (const api of [
      'exec',
      'pragma',
      'run',
      'get',
      'all',
      'iterate',
    ] as const) {
      it(`detects an unrecognized ${target} file effect through ${api} in ${boundary}`, () => {
        const output = probe(
          boundary,
          api === 'exec'
            ? "db.exec('SELECT hidden_effect()');"
            : api === 'pragma'
              ? "db.pragma('user_version');"
              : `${api === 'iterate' ? '[...' : ''}db.prepare('SELECT hidden_effect()').${api}()${api === 'iterate' ? ']' : ''};`,
          undefined,
          `const fs = require('node:fs');
           const mutate = () => {
             const file = db.name + ${JSON.stringify(target === 'wal' ? '-wal' : '')};
             const bytes = require('node:fs').readFileSync(file);
             bytes[bytes.length - 1] ^= 1;
             fs.writeFileSync(file, bytes);
             return 1;
           };
           db.function('hidden_effect', mutate);
           ${
             api === 'pragma'
               ? `
           // Exercise the native-pragma effect seam with a real file mutation.
           // Simulate an unrecognized native effect immediately after the
           // baseline bytes are sampled, independent of SQL admission patterns.
           const read = fs.readFileSync;
           let sampled = false;
           fs.readFileSync = function(file, ...args) {
             const result = read.call(this, file, ...args);
             if (file === db.name + ${JSON.stringify(target === 'wal' ? '-wal' : '')} && !sampled) {
               sampled = true;
               mutate();
             }
             return result;
           };
           require('node:module').syncBuiltinESMExports();`
               : ''
           }`,
        );
        expect(output).toContain('Unclassified ingress write:');
        expect(output).toContain(
          api === 'pragma' ? 'PRAGMA user_version' : 'SELECT hidden_effect()',
        );
        expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
      });
    }
  }

  it(`allows reads with a separate process reading the same WAL database in ${boundary}`, () => {
    const output = probe(
      boundary,
      `db.exec('SELECT external_reader()');
       db.pragma('user_version');
       for (const method of ['run', 'get', 'all', 'iterate']) {
         const result = db.prepare('SELECT value FROM probe')[method]();
         if (method === 'iterate') [...result];
       }
       console.log('ISOLATED_READS_PASSED');`,
      undefined,
      `db.function('external_reader', () => {
         const script = "const Database = require('better-sqlite3'); const reader = new Database(process.argv[1], {readonly: true}); reader.prepare('SELECT * FROM probe').all(); reader.close();";
         require('node:child_process').execFileSync(process.execPath, ['-e', script, db.name], { env: process.env });
         return 1;
       });`,
    );
    expect(output).toContain('ISOLATED_READS_PASSED');
    expect(output).not.toContain('Unclassified ingress write');
  });
}

for (const boundary of ['tick', 'consumeWatch'] as const) {
  it(`admits pre-existing read handles and allowlisted table functions in ${boundary}`, () => {
    const output = probe(
      boundary,
      `for (const method of ['run', 'get', 'all', 'iterate']) {
         const result = statement[method]();
         if (method === 'iterate') [...result];
       }
       db.exec("SELECT * FROM pragma_table_info('probe')");
       console.log('PREPARED_READS_PASSED');`,
      undefined,
      "const statement = db.prepare('SELECT * FROM probe');",
    );
    expect(output).toContain('PREPARED_READS_PASSED');
    expect(output).not.toContain('Unclassified ingress write');
  });

  it(`refuses optimize iterators created before ${boundary} on their first advance`, () => {
    const output = probe(
      boundary,
      'iterator.next();',
      undefined,
      "const iterator = db.prepare('PRAGMA optimize').iterate();",
    );
    expect(output).toContain('Unclassified ingress write: PRAGMA optimize');
    expect(output).toContain(`AgentMonitorRuntime.${boundary}`);
  });
}
