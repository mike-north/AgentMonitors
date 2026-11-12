/**
 * Pins which Zod implementation validates the channel server's inbound MCP
 * requests.
 *
 * `@modelcontextprotocol/sdk` 1.x ships a compatibility helper
 * (`server/zod-compat`) that parses with Zod 4 when handed a Zod 4 schema and
 * falls back to the bundled `zod/v3` implementation when handed a Zod 3
 * schema. The `zod/v3` implementation in Zod 4.x is still affected by
 * GHSA-mrhx-c7xc-m3w5 (excess array-element traversal past `.max()`), and a
 * version-only audit cannot see that, because the vulnerable code ships inside
 * the patched `zod` package.
 *
 * The channel server (`commands/channel.ts`) registers its handlers with the
 * SDK's own `ListToolsRequestSchema` and `CallToolRequestSchema`. These tests
 * prove that those schemas are Zod 4 schemas, and that a real
 * Client → Server round trip using them never enters the `zod/v3` parser. A
 * control case registers a Zod 3 schema to prove the probe detects the
 * fallback path, so the negative assertions are not vacuous.
 *
 * @see https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
 * @see https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z3 from 'zod/v3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  EmptyResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** Zod 4 schemas (classic and mini) carry a `_zod` internals record; Zod 3 schemas do not. */
function isZod4Schema(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_zod' in schema &&
    typeof schema._zod === 'object' &&
    schema._zod !== null
  );
}

/**
 * Counts every entry into the Zod 3 parser while the returned spies are active.
 *
 * Zod 3 binds `parse`/`safeParse` (and their async forms) onto each instance in
 * its constructor, so prototype spies on those never fire. Every one of them
 * funnels through the unbound `_parseSync` / `_parseAsync` prototype methods,
 * which is where the probe listens.
 */
function spyOnZod3Parsing() {
  return [
    vi.spyOn(z3.ZodType.prototype, '_parseSync'),
    vi.spyOn(z3.ZodType.prototype, '_parseAsync'),
  ];
}

function zod3CallCount(spies: ReturnType<typeof spyOnZod3Parsing>): number {
  return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

/** A connected client/server pair over the SDK's in-memory transport. */
async function connectPair(server: Server) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'zod-path-probe', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('channel MCP request validation uses Zod 4, not the zod/v3 fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers SDK request schemas that are Zod 4 schemas', () => {
    expect(isZod4Schema(ListToolsRequestSchema)).toBe(true);
    expect(isZod4Schema(CallToolRequestSchema)).toBe(true);
    expect(ListToolsRequestSchema).not.toBeInstanceOf(z3.ZodType);
    expect(CallToolRequestSchema).not.toBeInstanceOf(z3.ZodType);
  });

  it('never enters the zod/v3 parser for tools/list and tools/call round trips', async () => {
    const server = new Server(
      { name: 'agentmonitors-probe', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'agentmon_ack',
          description: 'probe',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [{ type: 'text' as const, text: request.params.name }],
    }));
    const client = await connectPair(server);
    const spies = spyOnZod3Parsing();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['agentmon_ack']);

      // An oversized argument payload: this is the input shape the advisory
      // concerns, and it must still be validated by Zod 4.
      const result = await client.callTool({
        name: 'agentmon_ack',
        arguments: {
          event_ids: Array.from({ length: 10_000 }, (_, i) => `e${i}`),
        },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'agentmon_ack' }]);

      expect(zod3CallCount(spies)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('control: the probe detects the zod/v3 fallback when a Zod 3 schema is registered', async () => {
    const server = new Server(
      { name: 'agentmonitors-probe', version: '0.0.0' },
      { capabilities: {} },
    );
    const Zod3ProbeRequestSchema = z3.object({
      method: z3.literal('probe/zod3'),
      params: z3.object({}).passthrough().optional(),
    });
    server.setRequestHandler(Zod3ProbeRequestSchema, () => ({}));
    const client = await connectPair(server);
    const spies = spyOnZod3Parsing();
    try {
      // The client validates the response with the SDK's Zod 4 schema, so any
      // zod/v3 entry observed here comes from the server's request parsing.
      await client.request(
        { method: 'probe/zod3', params: {} },
        EmptyResultSchema,
      );
      expect(zod3CallCount(spies)).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
