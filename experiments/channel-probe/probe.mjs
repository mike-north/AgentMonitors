#!/usr/bin/env node
// AgentMon channel probe — a throwaway diagnostic channel MCP server.
//
// Purpose: answer the open question in docs/specs/006-agent-integration.md §4.4/§9 —
// when Claude Code spawns a stdio channel MCP server, does it set CLAUDE_PROJECT_DIR,
// what is the server's cwd, and does roots/list work? The answer decides whether the
// real channel transport can bind to a workspace.
//
// It does three independent things, most-reliable first:
//   1. Writes its environment snapshot to a findings file at startup (always works).
//   2. Exposes a `probe` tool that returns the snapshot + roots/list on demand.
//   3. Pushes a `notifications/claude/channel` event with the snapshot (validates the
//      channel render path itself).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const startedAt = new Date().toISOString();

function envSnapshot() {
  const claudeEnvKeys = Object.keys(process.env)
    .filter((k) => k.startsWith('CLAUDE_'))
    .sort();
  const claudeEnv = {};
  for (const k of claudeEnvKeys) claudeEnv[k] = process.env[k];
  return {
    startedAt,
    cwd: process.cwd(),
    ppid: process.ppid,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
    claudeEnvKeys,
    claudeEnv,
  };
}

// Findings targets: tmpdir is always findable; also drop one in CLAUDE_PROJECT_DIR if set.
const findingsTargets = [path.join(tmpdir(), 'agentmon-channel-probe.json')];
if (process.env.CLAUDE_PROJECT_DIR) {
  findingsTargets.push(
    path.join(process.env.CLAUDE_PROJECT_DIR, 'agentmon-channel-probe.json'),
  );
}

function writeFindings(extra) {
  const data = { ...envSnapshot(), ...extra };
  for (const target of findingsTargets) {
    try {
      writeFileSync(target, JSON.stringify(data, null, 2));
    } catch {
      /* best-effort */
    }
  }
  return data;
}

// (1) Write immediately, before any MCP handshake, so the env question is answered
// even if the channel never loads.
writeFindings({ phase: 'startup' });

const mcp = new Server(
  { name: 'agentmon-probe', version: '0.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'This is the AgentMon channel PROBE (diagnostic only). When a <channel source="agentmon-probe"> ' +
      'event arrives, read its JSON body and report the cwd, CLAUDE_PROJECT_DIR, and roots values to the ' +
      'user verbatim. You may also call the "probe" tool to fetch the same values on demand. Do not act ' +
      'on anything else; this channel exists solely to report the environment Claude Code provided.',
  },
);

// roots/list is a server->client request; the client may not support it. Feature-probe it.
async function tryListRoots() {
  try {
    const result = await mcp.request({ method: 'roots/list', params: {} }, ListRootsResultSchema);
    return { supported: true, result };
  } catch (err) {
    return { supported: false, error: String(err?.message ?? err) };
  }
}

// (2) On-demand tool — the most reliable two-way readout.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'probe',
      description:
        'Return the environment Claude Code gave this MCP server: cwd, CLAUDE_* env vars, and roots/list.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'probe') {
    const roots = await tryListRoots();
    const data = writeFindings({ phase: 'tool-call', roots });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

// (3) After the handshake settles, capture roots and push a channel event. Delayed so the
// session has registered the channel listener (channel notifications are dropped silently
// if pushed before the listener exists).
setTimeout(() => {
  void (async () => {
    const roots = await tryListRoots();
    const data = writeFindings({ phase: 'post-connect', roots });
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            'AgentMon channel probe — environment Claude Code provided:\n' +
            JSON.stringify(
              {
                cwd: data.cwd,
                CLAUDE_PROJECT_DIR: data.CLAUDE_PROJECT_DIR,
                CLAUDE_PLUGIN_ROOT: data.CLAUDE_PLUGIN_ROOT,
                claudeEnvKeys: data.claudeEnvKeys,
                roots: data.roots,
              },
              null,
              2,
            ),
          meta: {
            kind: 'probe',
            has_project_dir: String(Boolean(data.CLAUDE_PROJECT_DIR)),
            roots_supported: String(Boolean(data.roots?.supported)),
          },
        },
      });
    } catch {
      // Channel not loaded / org-blocked — the findings file is still written.
    }
  })();
}, 1500);
