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
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import { renderChannelEvent } from '../channel-render.js';
import { renderHookDelivery } from '../hook-deliver-render.js';
import { buildEventBlock } from '../delivery-event-render.js';

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

  it('the channel push loop and `hook deliver` (both channel.ts and hook.ts) reserve/validate/commit — both reduce to the same core delivery decision (issue #300, issue #442 rounds 8-9)', () => {
    // The channel no longer claims BEFORE it pushes (that was the delivery-loss
    // bug, issue #300): it RESERVES, pushes, then COMMITS on success (or
    // RELEASES on a failed push). reserve/commit are the deferred form of the
    // hook's `hook.claim` — both reduce to the one core decide/apply — so
    // capability parity (006 §6.1) still holds: same daemon, same delivery
    // decision, different surface.
    expect(
      importsFromRuntimeClient(CHANNEL_SOURCE, 'reserveDeliveryClient'),
    ).toBe(true);
    expect(
      importsFromRuntimeClient(CHANNEL_SOURCE, 'commitDeliveryClient'),
    ).toBe(true);
    expect(
      importsFromRuntimeClient(CHANNEL_SOURCE, 'releaseDeliveryClient'),
    ).toBe(true);
    expect(CHANNEL_SOURCE).toMatch(/await\s+reserveDeliveryClient\s*\(/);
    expect(CHANNEL_SOURCE).toMatch(/await\s+commitDeliveryClient\s*\(/);
    expect(CHANNEL_SOURCE).toMatch(/releaseDeliveryClient\s*\(/);

    // The channel MUST NOT claim before surfacing — the removed bug.
    expect(CHANNEL_SOURCE).not.toMatch(/claimDeliveryClient/);

    // `hook deliver` (the CLI command a Claude Code hook actually invokes) no
    // longer claims directly either (issue #442, PR #442 round-8/round-9
    // review): it reserves, re-validates fit AND the candidate-growth race,
    // renders, WRITES, and only then commits — mirroring the channel's
    // reserve → push → commit ordering so a render/write failure can still be
    // recovered by releasing (nothing durably claimed) instead of losing a
    // delivery behind an already-applied commit.
    expect(importsFromRuntimeClient(HOOK_SOURCE, 'reserveDeliveryClient')).toBe(
      true,
    );
    expect(importsFromRuntimeClient(HOOK_SOURCE, 'commitDeliveryClient')).toBe(
      true,
    );
    expect(importsFromRuntimeClient(HOOK_SOURCE, 'releaseDeliveryClient')).toBe(
      true,
    );
    expect(HOOK_SOURCE).toMatch(/await\s+reserveDeliveryClient\s*\(/);
    // Called from a `commit`/`release` closure returned to the caller (never
    // committed/released until after a successful write), not directly
    // `await`ed inline the way the channel side is — so this only checks the
    // call itself is present, not the `await` keyword.
    expect(HOOK_SOURCE).toMatch(/commitDeliveryClient\s*\(/);
    expect(HOOK_SOURCE).toMatch(/releaseDeliveryClient\s*\(/);

    // Only the manual, single-shot `hook claim` subcommand (a human-invoked
    // debugging aid, not the hook-wired `deliver` path) still calls
    // `claimDeliveryClient` directly — it has no fallible surface (no push,
    // no render-then-write step) to defer a commit behind.
    expect(importsFromRuntimeClient(HOOK_SOURCE, 'claimDeliveryClient')).toBe(
      true,
    );
    expect(HOOK_SOURCE).toMatch(/await\s+claimDeliveryClient\s*\(/);
  });
});

/**
 * Rendering parity (issue #436): the two injecting transports must surface the
 * SAME event content — the channel is a rendering surface over the same
 * semantics, "only the surface" differs (006 §6). This exercises the REAL
 * renderers (`renderHookDelivery` and `renderChannelEvent`) against one shared
 * `DeliveryClaim`, not a hand-built approximation, and asserts both emit the
 * transport-shared per-event block (`buildEventBlock`): title + monitor body +
 * bounded change summary. Test data is ASCII with no tag-breakout or control
 * characters, so both transports' per-field sanitizers are identity here and the
 * blocks are byte-identical — isolating the parity contract from the transports'
 * distinct content-safety rules.
 */
describe('channel vs hook-deliver: rendering parity for the same event (issue #436)', () => {
  const identity = (value: string): string => value;

  function makeEvent(
    overrides: Partial<DeliveryEventSummary> = {},
  ): DeliveryEventSummary {
    return {
      eventId: 'e1',
      monitorId: 'merge-queue',
      title: 'A PR is ready to merge',
      summary: 'A PR is ready to merge',
      urgency: 'high',
      createdAt: '2026-07-18T00:00:00.000Z',
      body: 'Review the PR, then squash-merge it if CI is green.',
      diffText: '- label: needs-review\n+ label: ready-to-merge',
      ...overrides,
    };
  }

  function makeHighClaim(event: DeliveryEventSummary): DeliveryClaim {
    return {
      sessionId: 's1',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: event.title,
      unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
      events: [event],
    };
  }

  it('both transports render the identical per-event block (title + body + bounded diff)', () => {
    const event = makeEvent();
    const claim = makeHighClaim(event);
    const expectedBlock = buildEventBlock(event, identity);

    const hook = renderHookDelivery(claim, 'UserPromptSubmit');
    const hookContext = hook?.hookSpecificOutput.additionalContext ?? '';
    const { content: channelContent } = renderChannelEvent(claim);

    // The shared block appears verbatim in BOTH surfaces.
    expect(hookContext).toContain(expectedBlock);
    expect(channelContent).toContain(expectedBlock);

    // Concretely: title, monitor body, and change summary all reach both.
    for (const surface of [hookContext, channelContent]) {
      expect(surface).toContain('A PR is ready to merge');
      expect(surface).toContain(
        'Review the PR, then squash-merge it if CI is green.',
      );
      expect(surface).toContain('Changes:');
      expect(surface).toContain('+ label: ready-to-merge');
    }
  });

  it('a title-only render (no body, no diff reaching the agent) is a parity break — both now carry more than the title', () => {
    // This is the exact regression from issue #436: the channel used to render
    // claim.message (the title) alone. Assert neither surface is title-only.
    const claim = makeHighClaim(makeEvent());
    const hook = renderHookDelivery(claim, 'UserPromptSubmit');
    const hookContext = hook?.hookSpecificOutput.additionalContext ?? '';
    const { content: channelContent } = renderChannelEvent(claim);

    for (const surface of [hookContext, channelContent]) {
      // More than just the title line is present.
      expect(surface).toContain('Review the PR');
      expect(surface).toContain('Changes:');
    }
  });
});
