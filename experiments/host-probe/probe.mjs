#!/usr/bin/env node
// Generalized host-probe harness (spec 006 §11.6) — generalizes experiments/channel-probe.
//
// Run inside a target host session (as a lifecycle-hook command, and/or as a spawned MCP
// server), this records what is actually observable — the session-identity signal, the
// workspace-binding signal, and which lifecycle hook points fired — as durable JSONL
// "sightings", then reduces them into a single matrix-cell JSON artifact matching the
// 006 §11.3 contract dimensions. See README.md for the runbook.
//
// Modes:
//   record-hook   -- run as a lifecycle-hook command; reads the hook's stdin JSON payload.
//   record-mcp    -- run as a stdio MCP server (a channel/push-transport analogue).
//   summarize     -- reduce the JSONL sightings file into the final artifact.

import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import {
  buildHookSighting,
  buildMcpSighting,
  summarize as summarizeSightings,
  DEFAULT_ENV_PREFIXES,
} from './lib.mjs';

function parseArgs(argv) {
  const flags = { envPrefixes: [], notes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
        flags.out = argv[++i];
        break;
      case '--in':
        flags.in = argv[++i];
        break;
      case '--host':
        flags.host = argv[++i];
        break;
      case '--surface':
        flags.surface = argv[++i];
        break;
      case '--host-version':
        flags.hostVersion = argv[++i];
        break;
      case '--env-prefix':
        flags.envPrefixes.push(argv[++i]);
        break;
      case '--note':
        flags.notes.push(argv[++i]);
        break;
      case '--name':
        flags.name = argv[++i];
        break;
      case '--roots-delay':
        flags.rootsDelay = Number(argv[++i]);
        break;
      default:
        // Unknown flags are ignored rather than fatal — this is a diagnostic tool, and a
        // stray/typo'd flag should not crash a live hook invocation (same posture as
        // `agentmonitors hook deliver`'s swallow-errors rule, 006 §5.2).
        break;
    }
  }
  return flags;
}

function readAllStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function appendSighting(outPath, sighting) {
  appendFileSync(outPath, JSON.stringify(sighting) + '\n');
}

/** 006 §5.4: only these events honor `additionalContext`; only mark those "advisory-capable". */
const CONTEXT_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
]);

function recordHook(flags) {
  // This path is invoked from LIVE host hooks: it must be best-effort and
  // always emit a valid hook response, whatever stdin contained and whether
  // or not the sighting could be persisted. A throwing probe would degrade
  // the very session it is observing.
  try {
    recordHookInner(flags);
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }));
  }
}

function recordHookInner(flags) {
  const outPath =
    flags.out ??
    process.env.HOST_PROBE_ARTIFACT ??
    './host-probe-artifact.jsonl';
  const raw = readAllStdinSync();
  let payload = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    // JSON.parse can yield null / arrays / primitives; only a plain object is
    // a usable hook payload — anything else degrades to an empty sighting.
    payload =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch {
    payload = {};
  }

  const envPrefixes =
    flags.envPrefixes.length > 0 ? flags.envPrefixes : DEFAULT_ENV_PREFIXES;
  const sighting = buildHookSighting({
    payload,
    env: process.env,
    envPrefixes,
    pid: process.pid,
    ppid: process.ppid,
  });
  appendSighting(outPath, sighting);

  const hookEventName = payload.hook_event_name ?? null;
  const output = { continue: true };
  if (hookEventName && CONTEXT_EVENTS.has(hookEventName)) {
    // A marker string a runbook operator can grep out of the host's session transcript
    // (payload.transcript_path, when the host provides one) to independently confirm
    // advisory-context injection actually rendered (006 §11.1 dimension 2).
    output.hookSpecificOutput = {
      hookEventName,
      additionalContext: `[agentmon-host-probe] observed at ${sighting.at} on ${hookEventName}`,
    };
  }
  process.stdout.write(JSON.stringify(output));
}

async function recordMcp(flags) {
  const outPath =
    flags.out ??
    process.env.HOST_PROBE_ARTIFACT ??
    './host-probe-artifact.jsonl';
  const envPrefixes =
    flags.envPrefixes.length > 0 ? flags.envPrefixes : DEFAULT_ENV_PREFIXES;
  const serverName = flags.name ?? 'agentmon-host-probe';
  const rootsDelay = Number.isFinite(flags.rootsDelay)
    ? flags.rootsDelay
    : 1500;

  // Imported lazily: only `record-mcp` needs the MCP SDK, so `record-hook`/`summarize`
  // (the modes a lifecycle hook actually invokes on every turn) never pay for it.
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } =
    await import('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListRootsResultSchema,
  } = await import('@modelcontextprotocol/sdk/types.js');

  async function tryListRoots(mcp) {
    try {
      const result = await mcp.request(
        { method: 'roots/list', params: {} },
        ListRootsResultSchema,
      );
      return { supported: true, result };
    } catch (err) {
      return { supported: false, error: String(err?.message ?? err) };
    }
  }

  const capabilitiesDeclared = ['experimental.claude/channel', 'tools'];
  const mcp = new Server(
    { name: serverName, version: '0.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'This is the AgentMon generalized HOST PROBE (diagnostic only, spec 006 §11.6). ' +
        'It records the environment/roots this host gave a spawned MCP server. Do not act ' +
        'on anything else.',
    },
  );

  function recordPhase(phase, roots) {
    const sighting = buildMcpSighting({
      phase,
      cwd: process.cwd(),
      env: process.env,
      envPrefixes,
      roots,
      capabilitiesDeclared,
      pid: process.pid,
      ppid: process.ppid,
    });
    appendSighting(outPath, sighting);
    return sighting;
  }

  // Write immediately, before any MCP handshake — answers the env/cwd question even if
  // the channel transport analogue never loads (same "most-reliable readout" ordering as
  // experiments/channel-probe).
  recordPhase('startup', null);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'probe',
        description:
          'Return the environment/roots this host gave this MCP server.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'probe') {
      const roots = await tryListRoots(mcp);
      const sighting = recordPhase('tool-call', roots);
      return {
        content: [{ type: 'text', text: JSON.stringify(sighting, null, 2) }],
      };
    }
    throw new Error(`unknown tool: ${req.params.name}`);
  });

  await mcp.connect(new StdioServerTransport());

  setTimeout(() => {
    void (async () => {
      const roots = await tryListRoots(mcp);
      const sighting = recordPhase('post-connect', roots);
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `AgentMon host probe — environment observed:\n${JSON.stringify(
              { cwd: sighting.cwd, env: sighting.env, roots: sighting.roots },
              null,
              2,
            )}`,
            meta: { kind: 'host-probe' },
          },
        });
      } catch {
        // Channel/push analogue not loaded, or host-blocked — the sighting is already
        // recorded, so this is an expected, non-fatal condition (006 §6, generalized).
      }
    })();
  }, rootsDelay);
}

function summarizeMode(flags) {
  const inPath = flags.in;
  if (!inPath || !existsSync(inPath)) {
    console.error(
      `summarize: --in <sightings.jsonl> is required and must exist (got ${inPath})`,
    );
    process.exit(1);
  }
  const raw = readFileSync(inPath, 'utf8');
  const sightings = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const artifact = summarizeSightings(sightings, {
    host: flags.host ?? 'unknown-host',
    surface: flags.surface ?? 'cli',
    hostVersion: flags.hostVersion ?? null,
    notes: flags.notes,
  });

  const json = JSON.stringify(artifact, null, 2) + '\n';
  if (flags.out) {
    writeFileSync(flags.out, json);
  } else {
    process.stdout.write(json);
  }
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  switch (mode) {
    case 'record-hook':
      recordHook(flags);
      return;
    case 'record-mcp':
      await recordMcp(flags);
      return;
    case 'summarize':
      summarizeMode(flags);
      return;
    default:
      console.error(
        `usage: probe.mjs <record-hook|record-mcp|summarize> [flags]\nSee README.md for the runbook.`,
      );
      process.exit(1);
  }
}

// Hook invocations MUST always exit 0 (never interrupt the host session, 006 §5.2); errors
// here would otherwise surface as an uncaught exception to the calling host.
main().catch((err) => {
  console.error('host-probe error (non-fatal to the host):', err);
  process.exit(process.argv[2] === 'record-hook' ? 0 : 1);
});
