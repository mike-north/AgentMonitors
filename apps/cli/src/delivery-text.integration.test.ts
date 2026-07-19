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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The coalesced reminder body 002 §9.2/§9.3 requires the runtime to emit —
 * transcribed from the spec: semantic (no product-name attribution, which is
 * transport-owned), free of the legacy `inbox` model (002 §12), and naming
 * concrete runnable next steps — including the acknowledge step — with the
 * recipient's real session id interpolated.
 */
function expectedReminder(sessionId: string): string {
  return (
    `Monitored changes are pending. Run \`agentmonitors events list --session ${sessionId} --unread\` ` +
    `to see them, then \`agentmonitors events ack --session ${sessionId}\` once handled.`
  );
}

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  sessionId: string;
  workspacePath: string;
  /** Materialize one durable event of `urgency` into the shared workspace. */
  emit: (urgency: 'low' | 'normal' | 'high', objectKey: string) => void;
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
    emit: (urgency, objectKey) => {
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
        createdAt: new Date(),
      });
    },
  };
}

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
    //    and self-sufficient (real session id, runnable commands, ack step).
    expect(claim.message).toBe(expectedReminder(h.sessionId));
    expect(claim.message).not.toContain('AgentMon');
    expect(claim.message).not.toContain('inbox');

    // 2. HOOK transport: owns attribution → prepends its label, and preserves
    //    the semantic body verbatim after it.
    const hookOut = renderHookDelivery(claim, 'UserPromptSubmit');
    const hookCtx = hookOut?.hookSpecificOutput.additionalContext ?? '';
    expect(hookCtx).toBe(`AgentMon: ${expectedReminder(h.sessionId)}`);

    // 3. CHANNEL transport: adds NO attribution — the tag already names the
    //    source. The body is the runtime's semantic message verbatim.
    const { content, meta } = renderChannelEvent(claim);
    expect(content).toBe(expectedReminder(h.sessionId));
    expect(content).not.toContain('AgentMon');
    expect(meta['urgency']).toBe('normal');

    // 4. Both surfaces carry the same actionable next steps — the property that
    //    makes the delivered text self-sufficient on either transport.
    for (const surface of [hookCtx, content]) {
      expect(surface).toContain(
        `agentmonitors events list --session ${h.sessionId} --unread`,
      );
      expect(surface).toContain(
        `agentmonitors events ack --session ${h.sessionId}`,
      );
      expect(surface).not.toContain('inbox');
    }
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
      renderHookDelivery(first, 'UserPromptSubmit')?.hookSpecificOutput
        .additionalContext ?? '';

    // (a) The ORIGINAL delivery text contained the completion instruction.
    expect(deliveredText).toContain(
      `agentmonitors events ack --session ${h.sessionId}`,
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
    expect(afterAck?.message).toBe(expectedReminder(h.sessionId));
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
      renderHookDelivery(recap, 'SessionStart')?.hookSpecificOutput
        .additionalContext ?? '';
    expect(ctx).toContain(
      `When handled, acknowledge: agentmonitors events ack --session ${h.sessionId}`,
    );
    // Once per BATCH, not once per event (006 §5.1 injection-size concern).
    expect(ctx.split('When handled, acknowledge:').length - 1).toBe(1);
    // The recap still injects the real event bodies alongside it.
    expect(ctx).toContain('Review the change in doc-1.');
  });
});
