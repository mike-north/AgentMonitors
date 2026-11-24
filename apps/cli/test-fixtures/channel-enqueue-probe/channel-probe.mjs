#!/usr/bin/env node
/**
 * Manual-UAT probe for host channel confirmation (006 §4.5.2, issue #535).
 *
 * A dependency-free stdio MCP server that declares the `claude/channel`
 * capability and, 4 seconds after the host finishes initializing, pushes ONE
 * `notifications/claude/channel` event whose meta carries a fresh random
 * `delivery_id`. It then idles until the host closes stdin.
 *
 * Run it under Claude Code twice — once with and once without
 * `--dangerously-load-development-channels server:amprobe` — and look for a
 * `queue-operation` / `enqueue` transcript entry carrying the id. The recipe
 * is in docs/uat/channel-transport.md, "Part C".
 *
 * If PROBE_LOG is set, the pushed id is appended there so the run can be
 * matched against the transcript. Nothing else is written anywhere.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';

const log = process.env.PROBE_LOG;
const deliveryId = randomBytes(16).toString('hex');
const note = (line) => {
  if (log) appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
};
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
          serverInfo: { name: 'amprobe', version: '0.0.0' },
          instructions:
            'Probe channel for a manual test. If a <channel source="amprobe"> event arrives, reply only "probe seen".',
        },
      });
    } else if (message.method === 'notifications/initialized') {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'notifications/claude/channel',
          params: {
            content: 'probe event: reply "probe seen" and nothing else',
            meta: { delivery_id: deliveryId },
          },
        });
        note(`pushed delivery_id=${deliveryId}`);
      }, 4000);
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else if (message.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'not supported' },
      });
    }
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
