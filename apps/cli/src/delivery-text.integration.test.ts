/**
 * Integration coverage for the SELF-SUFFICIENCY of delivered text (issues #438
 * and #434), driving a REAL runtime (real store, real session projection, real
 * `claimDelivery` decision) and then rendering the resulting `DeliveryClaim`
 * through BOTH real transports — the hook-deliver renderer and the channel
 * renderer. That combination is what these two issues are actually about: one
 * semantic message produced by the host-agnostic core, attributed differently
 * by each delivery surface, and self-sufficient enough that a recipient can
 * finish the loop without consulting anything outside the payload.
 *
 * Expected values below are written from the spec (002 §9.2/§9.3, 006 §5.1/§5.5),
 * NOT read back from the implementation.
 *
 * @see ../../../docs/specs/002-runtime-delivery.md §9.2 (normal reminder wording
 *   contract, coalesced-until-ack)
 * @see ../../../docs/specs/006-agent-integration.md §5 (delivery format:
 *   transport-owned attribution, per-batch ack instruction)
 * @see https://github.com/mike-north/AgentMonitors/issues/438
 * @see https://github.com/mike-north/AgentMonitors/issues/434
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderChannelEvent } from './channel-render.js';
import { renderHookDelivery } from './hook-deliver-render.js';

const tempRoots: string[] = [];

// Both real transports (`hook deliver`, `channel serve`) always have a
// resolved daemon socket path on hand and thread it into every rendered
// action step (issue #358, PR #445 review finding 4) — a copy-pasted
// recovery command must never fall back to a stale `$AGENTMONITORS_SOCKET`.
// Exercising the renderers with no `socketPath` (as this suite previously
// did) asserts a string neither production surface ever actually emits, so
// every render call below passes this stable path and every expectation
// includes its `--socket` clause.
const TEST_SOCKET_PATH = '/tmp/agentmon-delivery-text-test.sock';
const SOCKET_CLAUSE = ` --socket '${TEST_SOCKET_PATH}'`;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The coalesced reminder body 002 §9.2/§9.3 requires the runtime to emit —
 * transcribed from the spec: semantic, transport- and verb-neutral (no
 * product-name attribution and no CLI verb, both transport-owned per PR #445
 * review finding 2), free of the legacy `inbox` model (002 §12).
 */
function expectedReminder(): string {
  return 'Monitored changes are pending.';
}

/**
 * The hook transport's own action step, appended after
 * {@link expectedReminder} (`hook-deliver-render.ts`'s
 * `buildHookReminderActionStep`): concrete, session-scoped CLI commands
 * including the acknowledge step.
 */
function expectedHookActionStep(sessionId: string): string {
  return (
    ` Run \`agentmonitors events list --session ${sessionId}${SOCKET_CLAUSE} --unread\` ` +
    `to see them, then \`agentmonitors events ack --session ${sessionId}${SOCKET_CLAUSE}\` once handled.`
  );
}

/**
 * The channel transport's own action step (`channel-render.ts`'s
 * `buildChannelReminderActionStep`): lists unread events FIRST — a
 * prerequisite, not an "or" alternative (PR #445 review, finding 2 round 2) —
 * then points at its `agentmon_ack` MCP tool, scoped to the handled ids,
 * rather than repeating the hook's CLI ack verb.
 */
function expectedChannelActionStep(sessionId: string): string {
  return (
    ' Run ' +
    `\`agentmonitors events list --session ${sessionId}${SOCKET_CLAUSE} --unread\` ` +
    'to see them, then call the agentmon_ack tool with the event_id values of the ones you handled.'
  );
}

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  sessionId: string;
  workspacePath: string;
  /** Materialize one durable event of `urgency` into the shared workspace. */
  emit: (
    urgency: 'low' | 'normal' | 'high',
    objectKey: string,
    createdAt?: Date,
  ) => void;
}

function buildHarness(hostSessionId: string): Harness {
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'agentmon-text-'));
  tempRoots.push(workspacePath);
  const db = createDb(':memory:');
  const store = new RuntimeStore(db);
  const runtime = new AgentMonitorRuntime(store, new SourceRegistry(), [
    claudeCodeAdapter,
  ]);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
  );
  return {
    runtime,
    store,
    sessionId: session.id,
    workspacePath,
    emit: (urgency, objectKey, createdAt = new Date()) => {
      store.insertEvent({
        workspacePath,
        monitorId: 'docs-monitor',
        sourceName: 'manual',
        urgency,
        title: `Change in ${objectKey}`,
        body: `Review the change in ${objectKey}.`,
        summary: `Change in ${objectKey}`,
        payload: {},
        snapshotMetadata: {},
        snapshotText: null,
        diffText: null,
        objectKey,
        queryScope: { doc: objectKey },
        tags: ['docs'],
        createdAt,
      });
    },
  };
}

// The high-urgency settle window (006 §5.2/§9.1): an event must be at least
// this old before a `turn-interruptible` claim will surface it.
const SETTLED = new Date(Date.now() - 60_000);

describe('delivered text is self-sufficient and transport-attributed (issues #438, #434)', () => {
  // Issue #438, the core acceptance criterion: ONE coalesced reminder produced
  // by the host-agnostic runtime, rendered by BOTH transports, each applying its
  // own attribution. The hook prefixes its label (its `additionalContext`
  // arrives in the context window unlabeled, so the source must be named); the
  // channel adds nothing (its `<channel source="agentmonitors">` tag already
  // names the source, so a prefix would double-attribute).
  it('renders one coalesced reminder with transport-appropriate attribution on hook and channel', () => {
    const h = buildHarness('claude-438-parity');
    h.emit('normal', 'doc-1');

    const claim = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    expect(claim).not.toBeNull();
    if (!claim) throw new Error('expected a coalesced reminder claim');
    expect(claim.urgency).toBe('normal');
    expect(claim.events).toEqual([]); // §9.2: a reminder carries no event bodies

    // 1. The RUNTIME's message is semantic: no product name, no legacy `inbox`,
    //    and carries no transport-specific verb (PR #445 review, finding 2) —
    //    each transport supplies its own concrete action step below.
    expect(claim.message).toBe(expectedReminder());
    expect(claim.message).not.toContain('AgentMon');
    expect(claim.message).not.toContain('inbox');

    // 2. HOOK transport: owns attribution → prepends its label, and appends
    //    its OWN CLI action step after the semantic body.
    const hookOut = renderHookDelivery(claim, 'UserPromptSubmit', {
      socketPath: TEST_SOCKET_PATH,
    });
    const hookCtx = hookOut?.hookSpecificOutput.additionalContext ?? '';
    expect(hookCtx).toBe(
      `AgentMon: ${expectedReminder()}${expectedHookActionStep(h.sessionId)}`,
    );

    // 3. CHANNEL transport: adds NO attribution — the tag already names the
    //    source. It appends its OWN `agentmon_ack`-pointing action step, never
    //    the hook's CLI ack verb.
    const { content, meta } = renderChannelEvent(claim, {
      socketPath: TEST_SOCKET_PATH,
    });
    expect(content).toBe(
      `${expectedReminder()}${expectedChannelActionStep(h.sessionId)}`,
    );
    expect(content).not.toContain('AgentMon');
    expect(content).not.toContain('events ack');
    expect(meta['urgency']).toBe('normal');

    // 4. Both surfaces carry a self-sufficient recovery command (the
    //    transport-neutral part) — but only the hook names the CLI ack verb;
    //    the channel points at its own tool instead (PR #445 review, finding
    //    2), so a channel-connected agent never gets two conflicting
    //    acknowledge paths.
    for (const surface of [hookCtx, content]) {
      expect(surface).toContain(
        `agentmonitors events list --session ${h.sessionId}${SOCKET_CLAUSE} --unread`,
      );
      expect(surface).not.toContain('inbox');
    }
    expect(hookCtx).toContain(
      `agentmonitors events ack --session ${h.sessionId}${SOCKET_CLAUSE}`,
    );
    expect(content).not.toContain('events ack');
  });

  // Issue #434: the delivered payload must name the ack step, because claiming
  // is not acknowledging — and until the recipient acknowledges, the
  // coalesced-until-ack rule silently mutes every later normal reminder. This
  // pins BOTH halves: the suppression still behaves exactly as 002 §9.2
  // specifies (unchanged), AND the text that was actually delivered told the
  // recipient how to prevent the mute.
  it('delivers the ack instruction, then still coalesces until that ack happens', () => {
    const h = buildHarness('claude-434-coalesce');
    h.emit('normal', 'doc-1');

    // Deliver → the reminder surfaces AND claims the event (claimed ≠ acked).
    const first = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    expect(first).not.toBeNull();
    if (!first) throw new Error('expected a first reminder claim');
    const deliveredText =
      renderHookDelivery(first, 'UserPromptSubmit', {
        socketPath: TEST_SOCKET_PATH,
      })?.hookSpecificOutput.additionalContext ?? '';

    // (a) The ORIGINAL delivery text contained the completion instruction.
    expect(deliveredText).toContain(
      `agentmonitors events ack --session ${h.sessionId}${SOCKET_CLAUSE}`,
    );

    // (b) The recipient acts but does NOT ack. A newer event fires...
    h.emit('normal', 'doc-2');

    // ...and the reminder is suppressed — unchanged 002 §9.2 behavior: the
    // coalesced reminder re-fires only when EVERY unread normal event is
    // unclaimed, and doc-1 is claimed-but-unacknowledged.
    expect(
      h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
    ).toBeNull();

    // (c) The instruction the payload gave is genuinely the remediation:
    // acknowledging unmutes the band, so the next event is delivered again.
    h.runtime.acknowledgeSession(h.sessionId);
    h.emit('normal', 'doc-3');
    const afterAck = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    expect(afterAck).not.toBeNull();
    expect(afterAck?.message).toBe(expectedReminder());
  });

  // Issue #434, the recap half of the DoD: a SessionStart (`post-compact`)
  // recap injects concrete event bodies and claims them, so it must carry the
  // ack instruction too — once for the whole batch, not per event.
  it('carries a single ack instruction in a post-compact recap batch', () => {
    const h = buildHarness('claude-434-recap');
    h.emit('normal', 'doc-1');
    h.emit('normal', 'doc-2');

    const recap = h.runtime.claimDelivery(h.sessionId, 'post-compact');
    expect(recap).not.toBeNull();
    if (!recap) throw new Error('expected a recap claim');
    expect(recap.mode).toBe('recap');
    expect(recap.events.length).toBeGreaterThan(0); // recap injects bodies

    const ctx =
      renderHookDelivery(recap, 'SessionStart', {
        socketPath: TEST_SOCKET_PATH,
      })?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      `When handled, acknowledge: agentmonitors events ack --session ${h.sessionId}${SOCKET_CLAUSE}`,
    );
    // Once per BATCH, not once per event (006 §5.1 injection-size concern).
    expect(ctx.split('When handled, acknowledge:').length - 1).toBe(1);
    // The recap still injects the real event bodies alongside it.
    expect(ctx).toContain('Review the change in doc-1.');
  });

  // PR #445 review, finding 1 (BLOCKER): `agentmonitors events ack --session
  // <id>` with no `--event-ids` acknowledges EVERY unread event for the
  // session. A CAPPED high-urgency delivery deferred the second event (it
  // genuinely stays pending and re-delivers per §5.5) — a compliant agent
  // that runs the delivered instruction verbatim must NOT silently acknowledge
  // (and thereby permanently drop from ordinary redelivery) the event it
  // never saw.
  it('scopes the ack instruction to only the rendered events of a capped high-urgency delivery, never the deferred remainder', () => {
    const h = buildHarness('claude-445-capped');
    h.emit('high', 'doc-1', SETTLED);
    h.emit('high', 'doc-2', SETTLED);

    // Cap the claim to exactly 1 event (mirrors the hook transport sizing a
    // length-bounded `additionalContext` — issue #299).
    const claim = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible', 1);
    expect(claim).not.toBeNull();
    if (!claim) throw new Error('expected a capped high-urgency claim');
    expect(claim.events).toHaveLength(1);
    const [renderedEvent] = claim.events;
    if (!renderedEvent) throw new Error('expected one rendered event');

    const ctx =
      renderHookDelivery(claim, 'PreToolUse', {
        moreDeferred: true,
        socketPath: TEST_SOCKET_PATH,
      })?.hookSpecificOutput.additionalContext ?? '';

    // The instruction names ONLY the rendered event's id.
    expect(ctx).toContain(
      `agentmonitors events ack --session ${h.sessionId}${SOCKET_CLAUSE} --event-ids ${renderedEvent.eventId}`,
    );
    // It must never claim to ack a second id — only one event was rendered.
    expect(ctx).not.toContain(`${renderedEvent.eventId},`);

    // The instruction, run exactly as delivered, must leave the deferred
    // event unread — proving no silent loss.
    h.runtime.acknowledgeSession(h.sessionId, [renderedEvent.eventId]);
    const stillUnread = h.store.unreadEventsForSession(h.sessionId, 'high');
    expect(stillUnread).toHaveLength(1);
    expect(stillUnread[0]?.objectKey).toBe('doc-2');
  });

  // PR #445 review, finding 1: the SAME scoping applies to a `post-compact`
  // recap, whose rendered `events` (up to 10, §9.4) can be fewer than the
  // FULL unread set the recap decision actually claims at commit time.
  it('scopes a recap ack instruction to only the rendered events, leaving un-rendered claimed events recoverable', () => {
    const h = buildHarness('claude-445-recap-scope');
    h.emit('normal', 'doc-1');
    h.emit('normal', 'doc-2');

    const recap = h.runtime.claimDelivery(h.sessionId, 'post-compact');
    expect(recap).not.toBeNull();
    if (!recap) throw new Error('expected a recap claim');
    const ids = recap.events.map((event) => event.eventId).join(',');

    const ctx =
      renderHookDelivery(recap, 'SessionStart', {
        socketPath: TEST_SOCKET_PATH,
      })?.hookSpecificOutput.additionalContext ?? '';
    expect(ctx).toContain(
      `When handled, acknowledge: agentmonitors events ack --session ${h.sessionId}${SOCKET_CLAUSE} --event-ids ${ids}`,
    );
  });
});
