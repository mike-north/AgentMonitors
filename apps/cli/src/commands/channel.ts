import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { DeliveryClaim, DeliveryReservation } from '@agentmonitors/core';
import { claudeCodeAdapter } from '@agentmonitors/core';
import {
  acknowledgeEventsClient,
  commitDeliveryClient,
  openSessionClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import {
  packChannelEventsUnderCap,
  renderChannelEvent,
} from '../channel-render.js';
import { ACK_TOOL, parseAckArgs } from '../channel-ack.js';

const DEFAULT_POLL_MS = 3000;

interface ChannelServeOptions {
  socket?: string;
  pollMs: string;
  hostSessionId?: string;
  workspace?: string;
}

export const channelCommand = new Command('channel').description(
  'Claude Code channel integration',
);

channelCommand
  .command('serve')
  .description(
    'Run the AgentMon channel: push pending turn-interruptible deliveries into the Claude Code session as channel events',
  )
  .option(
    '--socket <path>',
    'Daemon Unix domain socket path (default: the same per-workspace socket `session start` binds to when the workspace is enabled — this takes precedence over $AGENTMONITORS_SOCKET for `channel serve` specifically, since it is spawned automatically and a stale env var must not cross workspaces; otherwise $AGENTMONITORS_SOCKET or the global default)',
  )
  .option(
    '--poll-ms <ms>',
    'Delivery poll interval in milliseconds',
    String(DEFAULT_POLL_MS),
  )
  .option(
    '--host-session-id <id>',
    'Host session id (default: $CLAUDE_CODE_SESSION_ID)',
  )
  .option('--workspace <path>', 'Workspace path (default: $CLAUDE_PROJECT_DIR)')
  .action(async (options: ChannelServeOptions) => {
    await runChannelServe(options);
  });

/**
 * Resolve the socket `channel serve` connects to.
 *
 * `channel serve` is spawned **automatically** by the plugin's `.mcp.json` —
 * with no flags at all — exactly like a hook. That means its socket
 * resolution needs the same isolation guarantee `hook deliver` documents and
 * enforces (`apps/cli/src/commands/hook.ts`, "Require an EXPLICIT
 * per-workspace socket..."): a stale `AGENTMONITORS_SOCKET` left over from a
 * different workspace must never win over an **enabled** workspace's own
 * persisted-or-derived socket, or `channel serve` silently binds to another
 * workspace's daemon (a session-isolation break) or a dead socket
 * (reproducing issue #358's symptom).
 *
 * This is deliberately a *different* precedence than
 * {@link resolveManualDaemonSocketPath} (issue #335), which is correct for
 * commands a user types by hand (`session close`/`list`, `events`, `doctor`,
 * `daemon status`) — there, an explicitly-set env var is a deliberate,
 * interactive override and should win. `channel serve` has no such
 * interactive moment, so for it alone:
 *
 * 1. An explicit `--socket` flag (always wins).
 * 2. The **enabled** workspace's persisted socket, or — if none has
 *    persisted yet — the derived per-workspace socket
 *    ({@link workspacePaths}), matching the exact formula `session start`
 *    lazy-boots with (`resolveSocketPath(state.socket ?? workspacePaths(workspace).socket)`).
 * 3. `AGENTMONITORS_SOCKET`, then the global default — both handled by
 *    {@link resolveSocketPath}'s own fallback chain when neither 1 nor 2
 *    apply (e.g. the workspace is not enabled).
 *
 * Do not change {@link resolveManualDaemonSocketPath} to match this — its
 * env-first order for the manual commands is deliberate (issue #335).
 */
export function resolveChannelSocketPath(
  socket: string | undefined,
  workspace: string | undefined,
): string {
  if (socket) {
    return resolveSocketPath(socket, { explicit: true });
  }

  const workspacePath =
    workspace ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const state = readLocalState(workspacePath);
  if (state.enabled) {
    return resolveSocketPath(
      state.socket ?? workspacePaths(workspacePath).socket,
    );
  }

  // Not enabled: no per-workspace socket to prefer, so fall back to the
  // existing AGENTMONITORS_SOCKET / global-default chain.
  return resolveSocketPath(undefined);
}

/** The outcome of one {@link runChannelDeliveryCycle}. */
export type ChannelDeliveryOutcome =
  /** Nothing pending to surface this poll. */
  | 'idle'
  /** A claim was pushed and committed (surfaced, deduped from the hook path). */
  | 'surfaced'
  /** A claim was reserved but the push rejected; the reservation was released. */
  | 'push-failed'
  /**
   * The push was delivered, but the commit did not land: the reservation was
   * already gone (its lease expired during a slow/hung push, or the daemon
   * restarted and dropped its in-memory lease). The rows were never marked
   * claimed, so they stay eligible for re-delivery via the hook path or the next
   * poll. This makes channel delivery **at-least-once** in this rare window (a
   * possible duplicate surface) — never at-most-once (a lost delivery), which is
   * the safe direction. Distinct from `surfaced` so a caller never mistakes it
   * for a committed claim.
   */
  | 'surfaced-uncommitted';

/**
 * Upper bound on how many times {@link reserveSizedChannelDelivery} will
 * reserve → discover a size mismatch → release → retry before giving up on
 * sizing and forcing a single-event reservation (issue #442). Sizing and
 * reservation are two separate IPC calls (preview, then reserve), so the
 * candidate set can change between them; this bounds how long we chase a
 * moving target before falling back to the one reservation shape that is
 * ALWAYS safe (one event, whose own block `renderChannelEvent` mid-truncates
 * if it still exceeds the ceiling — `channel-render.ts`).
 */
const MAX_CHANNEL_RESERVE_ATTEMPTS = 3;

/**
 * Reserve a `turn-interruptible` delivery sized to fit under the channel's
 * content ceiling, tolerating the preview↔reserve race (006 §5.5, issue #442).
 *
 * Sizing (`previewSettledHighDeliveryClient` + `packChannelEventsUnderCap`) and
 * reservation (`reserveDeliveryClient`) are two SEPARATE IPC round-trips, so the
 * candidate set can change in between — either direction:
 *
 * - The preview was empty (no settled-high events yet), so `maxEvents` was
 *   omitted — but an event crosses the 15s settle boundary before `reserve`
 *   runs, and the reservation comes back carrying an unbounded, unsized claim.
 * - The previewed rows get leased/claimed by another transport (the hook path)
 *   before `reserve` runs, so `reserveDelivery` fills the requested COUNT from
 *   DIFFERENT pending events — events whose block sizes were never measured by
 *   the preview that produced `maxEvents`.
 *
 * Either way, `reserveDelivery`'s `maxEvents` bounds only the CANDIDATE
 * *count*, not the actually-claimed content size. This re-derives the fit from
 * the REAL claimed events (`packChannelEventsUnderCap(reservation.claim.events)`)
 * after every reserve, never trusting the earlier preview once a reservation
 * exists: if the actual claim doesn't fit, the reservation is released (so the
 * rows return to pending — no delivery is lost) and retried, tightening the
 * requested `maxEvents` to what was just measured. Bounded by
 * {@link MAX_CHANNEL_RESERVE_ATTEMPTS}; the final attempt forces `maxEvents: 1`,
 * which always terminates (`packChannelEventsUnderCap` of a single-event claim
 * is always ≥ its own length), so this never loops forever and always makes
 * forward progress. `renderChannelEvent`'s own defense-in-depth truncation
 * (`channel-render.ts`) is the last-resort backstop if even that single event's
 * own block exceeds the ceiling.
 *
 * Returns `null` when nothing is pending to reserve (mirrors `reserveDelivery`
 * returning `null`).
 */
export async function reserveSizedChannelDelivery(
  boundSession: string,
  socketPath: string,
): Promise<{ reservation: DeliveryReservation; moreDeferred: boolean } | null> {
  let forcedCap: number | undefined;
  for (let attempt = 1; attempt <= MAX_CHANNEL_RESERVE_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_CHANNEL_RESERVE_ATTEMPTS;
    const highPreview = await previewSettledHighDeliveryClient(
      boundSession,
      socketPath,
    );

    let maxEvents: number | undefined;
    let moreDeferred = false;
    if (isLastAttempt) {
      // Forward-progress fallback: repeated mismatches mean sizing keeps
      // racing with reservation. Force a single event so THIS attempt cannot
      // fail to make progress — a claim this small always fits (or is
      // mid-truncated by `renderChannelEvent` as the final backstop).
      maxEvents = 1;
      moreDeferred = highPreview.length > 1;
    } else if (highPreview.length > 0) {
      let fit = packChannelEventsUnderCap(highPreview);
      if (forcedCap !== undefined) fit = Math.min(fit, forcedCap);
      fit = Math.max(1, fit);
      maxEvents = fit;
      moreDeferred = fit < highPreview.length;
    } else if (forcedCap !== undefined) {
      // A prior attempt proved a smaller cap was needed, but this preview
      // raced empty (the oversized set already got reserved/claimed
      // elsewhere in between) — still force the known-safe cap so a freshly
      // settled event can't slip back in unbounded.
      maxEvents = forcedCap;
    }

    const reservation = await reserveDeliveryClient(
      boundSession,
      'turn-interruptible',
      socketPath,
      maxEvents,
    );
    if (!reservation) return null;

    // Trust only the ACTUAL claimed events from here — never the preview that
    // produced `maxEvents`, which can already be stale (see doc comment).
    const fitActual = packChannelEventsUnderCap(reservation.claim.events);
    if (fitActual >= reservation.claim.events.length) {
      return { reservation, moreDeferred };
    }

    // Mismatch: the actually-claimed set does not fit. Release it (the rows
    // return to pending — nothing is lost) and retry, tightening the cap to
    // what was just measured.
    await releaseDeliveryClient(reservation.reservationId, socketPath).catch(
      () => undefined,
    );
    forcedCap = Math.max(1, fitActual);
  }
  // Unreachable: the final (`isLastAttempt`) iteration above always returns,
  // since a single-event claim's fit is always ≥ its own length. Kept only to
  // satisfy the return type.
  return null;
}

/**
 * One reserve → push → commit/release delivery cycle for a bound session (006
 * §4, issue #300).
 *
 * Reserves the pending `turn-interruptible` delivery — which leases the rows so
 * the hook transport will not double-surface them (006 §4.5) — pushes the claim
 * via `push`, and COMMITS the claim only after the push resolves. If `push`
 * rejects (an MCP disconnect/rejection), the reservation is RELEASED so the rows
 * stay unclaimed and re-deliver via the hook transport or the next poll — a
 * transient failure never consumes the delivery. The rows are never
 * acknowledged by this path (BP2); a committed claim only means "was surfaced".
 *
 * **Bounded reservation (006 §5.5, issue #442).** {@link
 * reserveSizedChannelDelivery} sizes (and, if the preview↔reserve race leaves
 * an oversized or mismatched claim, re-sizes) the reservation so the
 * reserved/claimed set is sized to what `push` will actually render — the
 * claimed set still equals the rendered set (006 §5.5) — and any settled-high
 * events that do not fit stay pending, re-delivering on a later poll. `push`
 * receives a second `moreDeferred` flag so the renderer can signpost that more
 * is pending.
 *
 * Reserve/commit/release IPC errors propagate to the caller (the poll loop maps
 * them to "daemon unreachable → drop the cached session"); a `push` rejection is
 * handled here (release + `'push-failed'`), not thrown. The `push` seam is what
 * the integration test injects to exercise the success and disconnect paths
 * without a live Claude Code MCP host (channels are research-preview, §4/§6).
 */
export async function runChannelDeliveryCycle(
  boundSession: string,
  socketPath: string,
  push: (claim: DeliveryClaim, moreDeferred: boolean) => Promise<void>,
): Promise<ChannelDeliveryOutcome> {
  const sized = await reserveSizedChannelDelivery(boundSession, socketPath);
  if (!sized) return 'idle';
  const { reservation, moreDeferred } = sized;
  try {
    await push(reservation.claim, moreDeferred);
  } catch {
    // Push rejected/disconnected: release the reservation so the leased rows
    // return to pending and re-deliver via the hook path or the next poll (006
    // §4, issue #300). NEVER commit here — committing an unsurfaced claim is the
    // delivery-loss bug this cycle exists to prevent. Release is best-effort: if
    // it also fails (daemon unreachable), the reservation self-expires.
    await releaseDeliveryClient(reservation.reservationId, socketPath).catch(
      () => undefined,
    );
    return 'push-failed';
  }
  // Surfaced successfully: commit the claim now (the rows become claimed / "was
  // surfaced", deduped from the hook transport — 006 §4.5). Claim is not ack (BP2).
  // commit returns null when the reservation was already gone (lease expired
  // during a slow/hung push, or the daemon restarted): the push already
  // happened, but the rows were never claimed, so they stay eligible for
  // re-delivery (at-least-once). Report that honestly rather than a false
  // 'surfaced' — we must NOT claim success for a delivery that was not committed.
  const committed = await commitDeliveryClient(
    reservation.reservationId,
    socketPath,
  );
  return committed === null ? 'surfaced-uncommitted' : 'surfaced';
}

/**
 * Run the channel as a two-way MCP server. Outbound: poll the daemon for settled
 * `turn-interruptible` deliveries and push each into the session as a `<channel>`
 * event. Each poll RESERVES the delivery, pushes it, and COMMITS the claim only
 * after the push succeeds — so a rejected or disconnected push never permanently
 * consumes the delivery; the leased rows are released back to the hook transport
 * (006 §4, issue #300). Reserving leases the rows, so cross-transport dedup (006
 * §4.5) still holds during the push. Inbound: expose an `agentmon_ack` tool that
 * routes through `events.ack` so the agent can acknowledge what it has handled
 * (006 §4.3).
 */
async function runChannelServe(options: ChannelServeOptions): Promise<void> {
  const hostSessionId =
    options.hostSessionId ?? process.env['CLAUDE_CODE_SESSION_ID'];
  const workspace = options.workspace ?? process.env['CLAUDE_PROJECT_DIR'];
  const socketPath = resolveChannelSocketPath(options.socket, workspace);
  const pollMs = Number.parseInt(options.pollMs, 10) || DEFAULT_POLL_MS;

  // The low-level Server is the correct API for a channel: it exposes the custom
  // `notification()` and the `experimental['claude/channel']` capability that the
  // high-level McpServer (tools/resources) does not. This is the "advanced use
  // case" the deprecation notice points to, and what the reference channels use.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
  const mcp = new Server(
    { name: 'agentmonitors', version: '0.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'AgentMon delivers monitor events here as <channel source="agentmonitors" ...>. ' +
        'Read each one and act on the work it describes. The tag meta carries urgency, ' +
        'event_count, and (for a single event) monitor_id and event_id. When you have ' +
        'handled events, call the agentmon_ack tool with their event_id values (or no ' +
        'arguments to acknowledge all unread).',
    },
  );

  let sessionId: string | undefined;
  // session.open is idempotent: it resumes the session a SessionStart hook already
  // opened for this (adapter, hostSessionId), or opens a new one. Shared by the
  // poll loop and the ack tool.
  const resolveSession = async (): Promise<string> => {
    if (!hostSessionId) {
      throw new Error('no host session id available');
    }
    sessionId ??= (
      await openSessionClient(
        claudeCodeAdapter.createSessionInput({
          hostSessionId,
          ...(workspace ? { workspacePath: workspace } : {}),
        }),
        socketPath,
      )
    ).id;
    return sessionId;
  };

  // Inbound: advertise the agentmon_ack tool and route it through events.ack.
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [ACK_TOOL] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== ACK_TOOL.name) {
      throw new Error(`unknown tool: ${request.params.name}`);
    }
    const parsed = parseAckArgs(request.params.arguments);
    if (!parsed.ok) {
      return {
        content: [{ type: 'text', text: `Invalid arguments: ${parsed.error}` }],
        isError: true,
      };
    }
    try {
      const boundSession = await resolveSession();
      // events.ack only touches rows projected to this session, so passing the
      // bound session id is the "outbound gate" that re-authorizes the ids (006 §4.3).
      await acknowledgeEventsClient(
        boundSession,
        parsed.args.eventIds,
        socketPath,
      );
      // events.ack silently ignores ids not projected to this session and does
      // not report a count, so for explicit ids we frame the result as a request
      // (some ids may be unknown/stale); the all-unread path is unambiguous.
      const text = parsed.args.eventIds
        ? `Requested acknowledgement of ${String(parsed.args.eventIds.length)} event(s); ids not projected to this session are ignored.`
        : 'Acknowledged all unread events for this session.';
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Acknowledge failed: ${message}` }],
        isError: true,
      };
    }
  });

  await mcp.connect(new StdioServerTransport());

  // Without a host session id we cannot bind to a session. Stay connected (the
  // ack tool reports an error if called), but do not poll.
  if (!hostSessionId) {
    process.stderr.write(
      'agentmonitors channel: no CLAUDE_CODE_SESSION_ID available; not binding to a session.\n',
    );
    return;
  }

  const poll = async (): Promise<void> => {
    try {
      const boundSession = await resolveSession();
      const outcome = await runChannelDeliveryCycle(
        boundSession,
        socketPath,
        (claim, moreDeferred) => {
          const { content, meta } = renderChannelEvent(claim, {
            moreDeferred,
          });
          return mcp.notification({
            method: 'notifications/claude/channel',
            params: { content, meta },
          });
        },
      );
      if (outcome === 'surfaced-uncommitted') {
        // Rare: the push landed but the reservation lapsed before commit, so the
        // rows stay eligible for re-delivery (at-least-once). Note it on stderr;
        // stdout is the JSON-RPC channel and must not be written to.
        process.stderr.write(
          'agentmonitors channel: push delivered but commit did not land; rows remain eligible for re-delivery.\n',
        );
      }
    } catch {
      // Reserve/commit/release IPC failed → daemon unreachable / socket missing:
      // the hook-state transport still delivers durably (006 §7), and any
      // reservation we couldn't release self-expires. Drop the cached session id
      // and retry.
      sessionId = undefined;
    }
  };

  // Self-scheduling loop: the next poll is only armed after the current one
  // settles, so a slow daemon call can never overlap with the next poll.
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async (): Promise<void> => {
    await poll();
    if (!stopped) {
      timer = setTimeout(() => void loop(), pollMs);
      timer.unref();
    }
  };
  void loop();

  // MCP disconnect (stdin EOF): stop polling and close the transport, then let
  // the event loop drain naturally — no process.exit, so in-flight work and any
  // cleanup can complete first.
  process.stdin.on('end', () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    void mcp.close();
  });
}
