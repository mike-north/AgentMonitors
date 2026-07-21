/**
 * Issue #449 — the delivered event headline is the monitor's authored `name`,
 * not the source's implementation detail, on BOTH transports.
 *
 * Reported from a live delivery: a `command-poll` monitor polling GitHub through
 * a large `jq` program announced itself with ~400 characters of raw argv as its
 * `title` AND its `summary`, while its perfectly good authored name — "My PRs —
 * CI, review feedback, state changes" — appeared nowhere. The headline was the
 * monitor's own implementation, burning context on every delivery.
 *
 * The rule under test is transport-independent because core owns it: the title
 * is chosen once when the event is materialized (`processObservation`, 002 §5.4),
 * so the hook and channel renderers cannot diverge. These tests therefore drive
 * a REAL runtime tick against the REAL bundled `command-poll` source, claim a
 * REAL {@link DeliveryClaim}, and render that one claim through BOTH
 * `renderHookDelivery` and `renderChannelEvent`.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/449
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.4 (event title)
 * @see ../../../../docs/specs/003-source-plugins.md §11.4 (command-poll observation identity)
 * @see ../../../../docs/specs/006-agent-integration.md §4 (channel transport), §5 (hook transport)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
  type DeliveryClaim,
  type InterpretAdapter,
} from '@agentmonitors/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCoreSources } from '../sources.js';
import { renderChannelEvent } from '../channel-render.js';
import { renderHookDelivery } from '../hook-deliver-render.js';

const MONITOR_ID = 'my-prs';
const MONITOR_NAME = 'My PRs — CI, review feedback, state changes';

/**
 * A `jq`-shaped tail argument, standing in for the real ~250-character jq
 * program from the reported bug. It is inert: the Node program below never
 * reads `process.argv`, so this trailing element is never executed — a real
 * subprocess (no shell, no `jq`/`cat` binary dependency) whose stdout still
 * reflects `dataFile`'s current content, matching the command-poll source
 * suite's hermetic pattern (plugins/source-command-poll/src/index.test.ts,
 * "bounds the argv in title/summary … (issue #449)").
 */
const JQ_TAIL =
  `jq:[.[] | {number, state, draft: .isDraft, ` +
  `review: (if (.reviewDecision // "") == "" then "NONE" else .reviewDecision end), ` +
  `ci: (if (.statusCheckRollup // [] | length) == 0 then "NONE" else "PASSING" end)}]`;

/**
 * An argv in the shape that produced the bug: a long, jq-flavored trailing
 * argument. `command-poll` defaults `objectKey` to the joined argv, so
 * pre-fix this whole string was the delivered title.
 */
function longCommand(dataFile: string): string[] {
  return [
    process.execPath,
    '-e',
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(dataFile)}, 'utf8'))`,
    JQ_TAIL,
  ];
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  workspace: string;
  monitorsDir: string;
  dataFile: string;
  command: string[];
}

interface ScaffoldOptions {
  /**
   * `payload.form: prose` (G14, 002 §1.1.8): the only form that drives the
   * Interpret stage. Omitted for the plain title-fallback tests, which have
   * no need of a digest.
   */
  payloadForm?: 'prose';
  /**
   * A fake {@link InterpretAdapter} (never a real model shell-out in CI). Only
   * meaningful together with `payloadForm: 'prose'`.
   */
  interpretAdapter?: InterpretAdapter;
}

/**
 * Scaffold a workspace with one real `command-poll` monitor reading `data.json`.
 * `urgency: high` is what makes a claim carry event BODIES (normal/low deliver a
 * generic mid-session reminder, 002 §9.2), which is where the title is visible.
 * `name` is omitted entirely when `monitorName` is undefined — the fallback case.
 */
function scaffold(
  monitorName: string | undefined,
  options: ScaffoldOptions = {},
): Harness {
  const workspace = mkdtempSync(path.join(tmpdir(), 'agentmon-title-'));
  tempRoots.push(workspace);
  const dataFile = path.join(workspace, 'data.json');
  writeFileSync(dataFile, '[{"number":443,"state":"OPEN"}]', 'utf-8');
  const command = longCommand(dataFile);

  const monitorDir = path.join(workspace, '.claude', 'monitors', MONITOR_ID);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    [
      '---',
      ...(monitorName === undefined
        ? []
        : [`name: ${JSON.stringify(monitorName)}`]),
      'watch:',
      '  type: command-poll',
      `  command: ${JSON.stringify(command)}`,
      '  interval: 1s',
      'urgency: high',
      ...(options.payloadForm === undefined
        ? []
        : ['payload:', `  form: ${options.payloadForm}`]),
      'notify:',
      '  strategy: debounce',
      '  settle-for: 1s',
      '---',
      '',
      'Handle the pull-request changes.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const registry = new SourceRegistry();
  registerCoreSources(registry);
  const db = createDb(path.join(workspace, 'agentmon.db'));
  const store = new RuntimeStore(db);
  return {
    runtime: new AgentMonitorRuntime(
      store,
      registry,
      [claudeCodeAdapter],
      options.interpretAdapter,
    ),
    // A second store over the SAME db, the pattern used elsewhere for reading
    // durable state the claim payload does not expose.
    store: new RuntimeStore(db),
    workspace,
    monitorsDir: path.join(workspace, '.claude', 'monitors'),
    dataFile,
    command,
  };
}

/**
 * Baseline the command, change its output, and settle the debounce window so the
 * resulting high-urgency event is claimable — then claim it. Fake timers advance
 * both the notify window and the 15s high-urgency claim-time settle.
 */
async function deliverOneChange(harness: Harness): Promise<DeliveryClaim> {
  vi.useFakeTimers();
  const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
  vi.setSystemTime(t0);

  const session = harness.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'sess-lead',
      workspacePath: harness.workspace,
    }),
  );

  // Tick 1: first successful execution baselines silently (003 §11.4).
  await harness.runtime.tick(harness.monitorsDir, harness.workspace);

  // The change under observation: PR 443 merged, PR 447 appeared.
  writeFileSync(
    harness.dataFile,
    '[{"number":443,"state":"MERGED"},{"number":447,"state":"OPEN"}]',
    'utf-8',
  );

  vi.setSystemTime(t0 + 5_000);
  await harness.runtime.tick(harness.monitorsDir, harness.workspace); // observe → held
  vi.setSystemTime(t0 + 60_000); // past the notify window AND the high settle
  await harness.runtime.tick(harness.monitorsDir, harness.workspace); // flush

  const claim = harness.runtime.claimDelivery(session.id, 'turn-interruptible');
  expect(claim).not.toBeNull();
  expect(claim?.events.length).toBeGreaterThan(0);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted non-null above
  return claim!;
}

/** The two transports' rendered text for one claim. */
function renderBothTransports(claim: DeliveryClaim): {
  hook: string;
  channel: string;
} {
  const hook = renderHookDelivery(claim, 'PostToolUse');
  expect(hook).not.toBeNull();
  return {
    hook: hook?.hookSpecificOutput.additionalContext ?? '',
    channel: renderChannelEvent(claim).content,
  };
}

describe('issue #449: delivered event title is the monitor name, not the raw command', () => {
  it('a named command-poll monitor delivers its NAME as the title on both hook and channel', async () => {
    const harness = scaffold(MONITOR_NAME);
    const claim = await deliverOneChange(harness);

    // Core-owned: the materialized event itself carries the authored name.
    expect(claim.events[0]?.title).toBe(MONITOR_NAME);

    const { hook, channel } = renderBothTransports(claim);
    for (const rendered of [hook, channel]) {
      // The event's HEADLINE — the line right under the block's
      // `### <id> (<urgency>)` header — is the authored name, not the source's
      // text. (The hook transport prefixes a lead line before the block, so the
      // header is located rather than assumed to be the first line.)
      const lines = rendered.split('\n');
      const headerIndex = lines.findIndex((line) =>
        line.startsWith(`### ${MONITOR_ID} (`),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);
      expect(lines[headerIndex + 1]).toBe(MONITOR_NAME);
      // And the ~250-character jq program appears nowhere in delivered text:
      // the source's own line survives only in its bounded form.
      expect(rendered).not.toContain(JQ_TAIL);
      expect(rendered).toContain('Command output changed: ');
    }
  });

  it('an UNNAMED command-poll monitor falls back to the source title, with the command bounded', async () => {
    const harness = scaffold(undefined);
    const claim = await deliverOneChange(harness);
    const title = claim.events[0]?.title ?? '';

    // Documented fallback (002 §5.4): the source-provided title, unchanged.
    expect(title).toMatch(/^Command output changed: /);
    // …but the interpolated objectKey is bounded (003 §2.8), so a 200-character
    // argv can no longer become the headline.
    expect(title.length).toBeLessThan(90);
    expect(title).not.toContain(JQ_TAIL);
    expect(title.endsWith('…')).toBe(true);

    const { hook, channel } = renderBothTransports(claim);
    for (const rendered of [hook, channel]) {
      expect(rendered).toContain('Command output changed: ');
      expect(rendered).not.toContain(JQ_TAIL);
    }
  });

  it('keeps the FULL command in the event payload for debugging (regression)', async () => {
    const harness = scaffold(MONITOR_NAME);
    const claim = await deliverOneChange(harness);
    const eventId = claim.events[0]?.eventId ?? '';

    const stored = harness.store
      .listEvents({ workspacePath: harness.workspace })
      .find((event) => event.id === eventId);
    expect(stored).toBeDefined();
    expect(stored?.payload).toMatchObject({ command: harness.command });
    // The untruncated argv also remains the event's stable identity.
    expect(stored?.objectKey).toBe(harness.command.join(' '));
    // And the source's own detail is not lost — it is the summary.
    expect(stored?.summary).toMatch(/^Command output changed: /);
  });

  // Regression (issue #449 review, 2026-07-21): the prior review round required
  // a real runtime claim with a distinct Interpret digest — driven through BOTH
  // real transports, not just the shared `buildEventBlock` unit. A `prose`
  // monitor's `summary` is the Interpret digest (G14, 002 §1.1.8), which shares
  // no text with the deterministic per-object `objectDetail`; a transport that
  // dropped either would either lose object identity or silently discard a
  // successful agentic digest.
  it('a named, multi-object prose monitor renders BOTH the deterministic object detail AND the distinct Interpret digest, on both real transports (issue #449 review)', async () => {
    const digest = 'The status page reported a brief outage.';
    const fake: InterpretAdapter = {
      name: 'fake-interpret',
      interpret() {
        return Promise.resolve({ decision: 'deliver', digest });
      },
    };
    const harness = scaffold(MONITOR_NAME, {
      payloadForm: 'prose',
      interpretAdapter: fake,
    });
    const claim = await deliverOneChange(harness);

    // Core-owned: objectDetail is the deterministic per-object text (never
    // digest-replaced, 002 §5.4); summary is the recipient-visible digest —
    // and the two are distinct here, on purpose.
    const objectDetail = claim.events[0]?.objectDetail ?? '';
    const summary = claim.events[0]?.summary ?? '';
    expect(objectDetail).toMatch(/^Command output changed: /);
    expect(summary).toBe(digest);
    expect(summary).not.toBe(objectDetail);

    const { hook, channel } = renderBothTransports(claim);
    for (const rendered of [hook, channel]) {
      const lines = rendered.split('\n');
      const headerIndex = lines.findIndex((line) =>
        line.startsWith(`### ${MONITOR_ID} (`),
      );
      expect(headerIndex).toBeGreaterThanOrEqual(0);
      // Name first (the title), then the deterministic object identity, then
      // the distinct Interpret digest — neither dropped, in this exact order
      // (`buildEventBlock`, 002 §5.4 / issue #449 review).
      expect(lines[headerIndex + 1]).toBe(MONITOR_NAME);
      expect(lines[headerIndex + 2]).toBe(objectDetail);
      expect(lines[headerIndex + 3]).toBe(digest);
    }
  });
});
