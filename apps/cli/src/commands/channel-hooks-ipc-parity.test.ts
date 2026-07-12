/**
 * Static parity check for issue #270 ("Prove and document hooks-only (no-MCP)
 * operation as a first-class mode").
 *
 * This is DELIBERATELY separate from the "hooks-only delivery parity"
 * integration test in `cli.integration.test.ts`, which proves the full
 * lifecycle works with ZERO reference to the channel/MCP code path. This file
 * covers the other half of acceptance criterion 2 (capability parity): it
 * inspects channel.ts's SOURCE TEXT via `readFileSync` — it never imports or
 * executes channel.ts, so no `@modelcontextprotocol/sdk` is loaded and no MCP
 * server is started anywhere in this file — to confirm that the `agentmon_ack`
 * tool handler and the channel's outbound push are wired to the exact same
 * daemon-IPC client functions (`acknowledgeEventsClient` /
 * `claimDeliveryClient` in `runtime-client.ts`) that the hooks-only
 * `events ack` / `hook deliver` CLI commands call.
 *
 * That shared plumbing is what makes the hooks-only lifecycle proven in
 * `cli.integration.test.ts` a genuine substitute for the MCP tool's
 * capability — not just a superficially similar command: both transports
 * drive the identical daemon IPC methods (`events.ack`, `hook.claim`),
 * exactly as 006 §2's "realization" note describes ("the transport boundary
 * is the daemon IPC surface, not a new core type").
 *
 * @see docs/specs/006-agent-integration.md §2 and §4.3 (the agentmon_ack tool)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CHANNEL_SOURCE = readFileSync(
  path.resolve(__dirname, 'channel.ts'),
  'utf-8',
);
const EVENTS_SOURCE = readFileSync(
  path.resolve(__dirname, 'events.ts'),
  'utf-8',
);
const HOOK_SOURCE = readFileSync(path.resolve(__dirname, 'hook.ts'), 'utf-8');

/** True if `source` imports `name` from the shared runtime-client module. */
function importsFromRuntimeClient(source: string, name: string): boolean {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\.\\./runtime-client\\.js'`,
  ).test(source);
}

describe('agentmon_ack MCP tool vs. hooks-only CLI: shared daemon-IPC plumbing (static, issue #270)', () => {
  it('the agentmon_ack tool handler (channel.ts) and `events ack` (events.ts) both call acknowledgeEventsClient from the same module', () => {
    expect(
      importsFromRuntimeClient(CHANNEL_SOURCE, 'acknowledgeEventsClient'),
    ).toBe(true);
    expect(
      importsFromRuntimeClient(EVENTS_SOURCE, 'acknowledgeEventsClient'),
    ).toBe(true);
    // Not just imported — actually invoked by both ack handlers.
    // (Whitespace-tolerant so a formatter reflow can't break the assertion.)
    expect(CHANNEL_SOURCE).toMatch(/await\s+acknowledgeEventsClient\s*\(/);
    expect(EVENTS_SOURCE).toMatch(/await\s+acknowledgeEventsClient\s*\(/);
  });

  it('the channel push loop (channel.ts) and `hook deliver`/`hook claim` (hook.ts) both call claimDeliveryClient from the same module', () => {
    expect(
      importsFromRuntimeClient(CHANNEL_SOURCE, 'claimDeliveryClient'),
    ).toBe(true);
    expect(importsFromRuntimeClient(HOOK_SOURCE, 'claimDeliveryClient')).toBe(
      true,
    );
    expect(CHANNEL_SOURCE).toMatch(/await\s+claimDeliveryClient\s*\(/);
    expect(HOOK_SOURCE).toMatch(/await\s+claimDeliveryClient\s*\(/);
  });
});
