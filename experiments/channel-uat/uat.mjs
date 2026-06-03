#!/usr/bin/env node
/**
 * Automated end-to-end UAT for the AgentMon channel transport.
 *
 * Channels are a Claude Code research-preview feature, so a *real* Claude session
 * can't run in CI. But the thing under test is the channel server itself — does
 * `agentmonitors channel serve` resolve its session, poll the daemon, claim a
 * settled delivery, render it, and PUSH a `<channel>` notification? We can verify
 * that without Claude by playing the role of the MCP host: connect to the channel
 * server over stdio with the real MCP SDK client and assert it pushes.
 *
 * Flow (the real production path, end to end):
 *   1. scaffold a temp workspace with a `file-fingerprint` monitor (urgency: normal,
 *      so claimDelivery returns immediately — no 15s high-urgency settle);
 *   2. start a real `agentmonitors daemon run` on a private socket + db;
 *   3. spawn `agentmonitors channel serve` as an MCP server and connect to it as a
 *      client — it inherits CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR and opens
 *      its bound session against the daemon;
 *   4. mutate the watched file → the daemon's next tick materializes a normal-urgency
 *      event and projects it into the bound (lead) session;
 *   5. assert the channel server pushes a `notifications/claude/channel` for it.
 *
 * Exit 0 = the channel pushed; exit 1 = no push within the timeout (or setup error).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CLI = path.join(repoRoot, 'apps', 'cli', 'dist', 'index.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => process.stderr.write(`[uat] ${msg}\n`);

function waitForLine(stream, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${needle}"`));
    }, timeoutMs);
    stream.on('data', onData);
  });
}

async function main() {
  // `node uat.mjs [normal|high]` — high exercises the concrete-event push after the
  // 15s high-urgency settle; normal (default) exercises the coalesced reminder push.
  const urgency = process.argv[2] === 'high' ? 'high' : 'normal';
  // high urgency settles for ~15s before claimDelivery returns it, so wait longer.
  const pushWindowMs = urgency === 'high' ? 25_000 : 15_000;

  const work = mkdtempSync(path.join(tmpdir(), 'agentmon-chan-uat-'));
  const monitorsRoot = path.join(work, '.claude', 'monitors');
  const monitorDir = path.join(monitorsRoot, 'watch-files');
  mkdirSync(monitorDir, { recursive: true });
  const watched = path.join(work, 'watched.txt');
  writeFileSync(watched, 'hello', 'utf-8');
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    `---
name: Watch files
source: file-fingerprint
urgency: ${urgency}
event-kind: mutation
scope:
  globs:
    - watched.txt
  cwd: ${JSON.stringify(work)}
  interval: '1s'
---
When files change, review them.
`,
    'utf-8',
  );

  const sock = path.join(tmpdir(), `agentmon-chan-uat-${process.pid}.sock`);
  const db = path.join(work, 'agentmon.db');
  const env = { ...process.env, AGENTMONITORS_DB: db, AGENTMONITORS_SOCKET: sock };

  let daemon;
  let client;
  let received = null;

  const cleanup = async () => {
    try {
      if (client) await client.close();
    } catch {
      /* ignore */
    }
    // SIGTERM the daemon and *wait* for it to actually exit, escalating to SIGKILL,
    // so it can't outlive this harness as an orphan holding the socket.
    if (daemon && daemon.exitCode === null) {
      await new Promise((resolve) => {
        const kill9 = setTimeout(() => {
          try {
            daemon.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 2_000);
        kill9.unref?.();
        daemon.once('exit', () => {
          clearTimeout(kill9);
          resolve();
        });
        try {
          daemon.kill('SIGTERM');
        } catch {
          clearTimeout(kill9);
          resolve();
        }
      });
    }
    // Remove the workspace and the Unix socket file (the daemon may leave it behind,
    // and a stale socket can interfere with a subsequent run).
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(sock, { force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    // 2. real daemon on a private socket
    daemon = spawn(
      'node',
      [CLI, 'daemon', 'run', monitorsRoot, '--workspace', work, '--poll-ms', '300', '--socket', sock],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
    await waitForLine(daemon.stdout, 'AgentMon daemon listening', 10_000);
    log('daemon listening');

    // 3. connect to `channel serve` as an MCP client
    client = new Client({ name: 'channel-uat', version: '0.0.0' }, { capabilities: {} });
    client.fallbackNotificationHandler = (notification) => {
      if (notification.method === 'notifications/claude/channel') {
        received = notification.params;
      }
    };
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI, 'channel', 'serve', '--socket', sock, '--poll-ms', '400'],
      env: {
        ...env,
        CLAUDE_CODE_SESSION_ID: 'channel-uat-session',
        CLAUDE_PROJECT_DIR: work,
      },
      stderr: 'inherit',
    });
    await client.connect(transport);
    log('connected to `channel serve`; it is opening its bound session');

    // 4. let the channel open its session + take a baseline poll
    await sleep(2500);

    // 5. mutate the watched file → daemon makes a normal-urgency event → projects it
    writeFileSync(watched, 'hello world', 'utf-8');
    log(`mutated watched.txt; waiting up to ${Math.round(pushWindowMs/1000)}s for the <channel> push (urgency=${urgency})…`);

    // 6. wait for the push
    const start = Date.now();
    while (received === null && Date.now() - start < pushWindowMs) {
      await sleep(200);
    }

    if (received) {
      log('PASS — channel pushed notifications/claude/channel:');
      process.stdout.write(`${JSON.stringify(received, null, 2)}\n`);
      await cleanup();
      process.exit(0);
    }
    log('FAIL — no <channel> push within the timeout');
    await cleanup();
    process.exit(1);
  } catch (err) {
    console.error('[uat] error:', err);
    await cleanup();
    process.exit(1);
  }
}

void main();
