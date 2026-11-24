import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryReservation,
} from '@agentmonitors/core';
import {
  CHANNEL_DELIVERY_ID_META_KEY,
  claudeCodeAdapter,
} from '@agentmonitors/core';
import {
  acknowledgeEventsClient,
  commitDeliveryClient,
  openSessionClient,
  previewCoalescedReminderClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import {
  MAX_CHANNEL_CONTENT,
  packChannelEventsUnderCap,
  renderChannelEvent,
  resolveChannelClaimFit,
} from '../channel-render.js';
import {
  ACK_TOOL,
  buildAckResultText,
  LEASED_ROW_EXCEPTION,
  parseAckArgs,
} from '../channel-ack.js';
import { getCliVersion } from '../cli-version.js';
import {
  MAX_TIMER_DELAY_MS,
  parseIntegerOption,
  type IntegerOptionRange,
} from '../integer-option.js';
import { reportError } from '../output.js';
import {
  CHANNEL_HEARTBEAT_TTL_MS,
  removeTransportHeartbeat,
  writeTransportHeartbeat,
} from '../transport-heartbeat.js';
import {
  createTranscriptConfirmer,
  type ChannelPushConfirmer,
} from '../channel-push-confirmation.js';
import { ChannelRoute } from '../channel-route.js';

/** Poll interval used when `--poll-ms` is omitted. */
const DEFAULT_POLL_MS = 3000;

/**
 * Accepted `--poll-ms` range. The floor bounds how hard a mistyped value can
 * drive the daemon: every poll is a socket round trip plus a heartbeat file
 * write, so 100 ms caps the loop at ten iterations a second. The ceiling is the
 * largest delay Node's timers honor; beyond it `setTimeout` fires after 1 ms.
 * @internal
 */
export const CHANNEL_POLL_MS_RANGE: IntegerOptionRange = {
  min: 100,
  max: MAX_TIMER_DELAY_MS,
};

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
    `Delivery poll interval in milliseconds, a whole number from ${String(CHANNEL_POLL_MS_RANGE.min)} to ${String(CHANNEL_POLL_MS_RANGE.max)}`,
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
  /**
   * No usable host evidence source for this session (006 §4.5.2), so nothing
   * was reserved or pushed: a push that could never be confirmed would only be
   * released again. The hook path delivers.
   */
  | 'no-confirmation-source'
  /** The host confirmed the push and the claim was committed (deduped from the hook path). */
  | 'surfaced'
  /** A claim was reserved but the push rejected; the reservation was released. */
  | 'push-failed'
  /**
   * The push call resolved, but the host never confirmed it within the bound
   * (006 §4.5.2) — typically a host that loaded the channel without a
   * listener and dropped the event (006 §12.6). The reservation was released,
   * so the rows return to pending and the hook path delivers them. If the host
   * did surface it after all, the result is a duplicate, never a loss (PP1).
   */
  | 'unconfirmed'
  /**
   * The host confirmed the push, but the commit did not land: the reservation
   * was already gone (the daemon restarted and dropped its in-memory lease, or
   * the lease expired). The rows were never marked claimed, so they stay
   * eligible for re-delivery via the hook path or the next poll. This makes
   * channel delivery **at-least-once** in this rare window (a possible
   * duplicate surface) — never at-most-once (a lost delivery), which is the
   * safe direction. Distinct from `surfaced` so a caller never mistakes it for
   * a committed claim.
   */
  | 'surfaced-uncommitted';

/**
 * Mint the identifier one push carries in its `delivery_id` meta (006
 * §4.5.2). 128 random bits as lowercase hex: unique per push, and made only of
 * characters no tag escaping can alter, so the host's rendered copy matches
 * byte for byte.
 */
export function mintChannelDeliveryId(): string {
  return randomBytes(16).toString('hex');
}

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
 * How much channel `content` room to reserve for a coalesced normal-urgency
 * reminder (issue #441 cross-monitor coalescing; PR #456 review finding 4) —
 * mirrors `hook.ts`'s identical `reminderFooterLength`. See its doc comment.
 */
function reminderFooterLength(reminder: string | undefined): number {
  return reminder ? reminder.length + 2 : 0;
}

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
 * the REAL claimed events via {@link resolveChannelClaimFit} after every
 * reserve, never trusting the earlier preview once a reservation exists —
 * critically, the SAME predicate `renderChannelEvent` itself uses to decide
 * whether it needs to append `CHANNEL_DEFERRED_MARKER` (issue #442, PR #442
 * round-3 review): sizing the actual claim against the full cap while the
 * renderer sizes against (cap − marker) whenever a marker is needed would let
 * a claim through here that the renderer then silently shrinks. If the actual
 * claim doesn't fit, the reservation is released (so the rows return to
 * pending — no delivery is lost; the release itself is NOT best-effort here —
 * see below) and retried, tightening the requested `maxEvents` to what was
 * just measured. Bounded by {@link MAX_CHANNEL_RESERVE_ATTEMPTS}; the final
 * attempt forces `maxEvents: 1`, which always terminates (a single-event
 * claim's fit is always whole), so this never loops forever and always makes
 * forward progress. `renderChannelEvent`'s own defense-in-depth truncation
 * (`channel-render.ts`) is the last-resort backstop if even that single event's
 * own block exceeds the ceiling.
 *
 * A release failure on the mismatch path PROPAGATES (unlike the push-failure
 * release in `runChannelDeliveryCycle`, which is best-effort since the
 * reservation self-expires either way): silently swallowing it here would
 * leave the oversized reservation leased while this loop discards its id, so
 * a later `reserveDelivery` could come back `null` and the cycle would
 * misreport `'idle'` while those rows stay unavailable until lease expiry —
 * contradicting the "reserve/commit/release IPC errors propagate" contract
 * (issue #442, PR #442 round-3 review).
 *
 * Returns `null` when nothing is pending to reserve (mirrors `reserveDelivery`
 * returning `null`).
 */
/**
 * Whether settled high-urgency work remains pending BEYOND the events this
 * attempt just claimed (issue #442, PR #442 round-6 review — "candidate-set
 * growth" race).
 *
 * A `moreDeferred` computed only from the preview that PRECEDED this
 * reservation can go stale in the other direction from the races {@link
 * reserveSizedChannelDelivery} already re-sizes for: the preview held exactly
 * as many events as `maxEvents`, so `moreDeferred` was computed `false` — but
 * a SECOND event settles (crosses the 15s debounce boundary) in the gap
 * between that preview and this `reserve` call. The claim legitimately
 * contains only the first event and fits under the ceiling, so the earlier
 * mismatch check (`resolveChannelClaimFit`) reports `fits: true` — that check
 * only asks "does the CLAIMED set fit", never "is there MORE settled work
 * than what got claimed". Left unchecked, the push would render with no
 * {@link CHANNEL_DEFERRED_MARKER} even though the second, now-settled event
 * stays pending — contrary to 006 §5.5 ("the render omits any pending event
 * ... signposting that more updates are pending").
 *
 * Re-runs the SAME read-only preview {@link reserveSizedChannelDelivery}
 * itself uses for sizing (no core changes required) and compares it against
 * the actually-claimed event ids — a settled event that is NOT in the claim
 * means genuine deferred work remains.
 */
async function settledWorkRemainsBeyondClaim(
  boundSession: string,
  socketPath: string,
  claimedEvents: DeliveryEventSummary[],
): Promise<boolean> {
  const claimedIds = new Set(claimedEvents.map((event) => event.eventId));
  const stillSettled = await previewSettledHighDeliveryClient(
    boundSession,
    socketPath,
  );
  return stillSettled.some((event) => !claimedIds.has(event.eventId));
}

export async function reserveSizedChannelDelivery(
  boundSession: string,
  socketPath: string,
): Promise<{ reservation: DeliveryReservation; moreDeferred: boolean } | null> {
  let forcedCap: number | undefined;
  for (let attempt = 1; attempt <= MAX_CHANNEL_RESERVE_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_CHANNEL_RESERVE_ATTEMPTS;
    const [highPreview, coalescedReminder] = await Promise.all([
      previewSettledHighDeliveryClient(boundSession, socketPath),
      previewCoalescedReminderClient(boundSession, socketPath),
    ]);
    const reminderReserve = reminderFooterLength(coalescedReminder);

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
      let fit = packChannelEventsUnderCap(
        highPreview,
        MAX_CHANNEL_CONTENT - reminderReserve,
      );
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

    // An eventless claim is a REMINDER (normal/low urgency, no settled-high
    // body to inject): `reserveDelivery` legitimately returns one even when
    // the preview above saw settled-high rows and set `maxEvents`/`moreDeferred`
    // from them, because the preview↔reserve race let another transport
    // lease/claim those previewed rows first (core ignores `maxEvents` for the
    // reminder branch — it isn't sizing a body). `renderChannelEvent` renders
    // the reminder's coalesced `message` as-is and never consults
    // `moreDeferred`/`resolveChannelClaimFit` on this path (`channel-render.ts`),
    // so validating the STALE high-preview's `moreDeferred` against this empty
    // claim is meaningless: `resolveChannelClaimFit([], true, cap)` always
    // reports `fits: false` (an empty block list can never satisfy a
    // `moreDeferred`-forced marker fit), which released a perfectly valid
    // reminder and retried/looped instead of surfacing it (issue #442, PR #442
    // round-4 review). Accept it directly and clear `moreDeferred` — it
    // describes the stale high preview, not this claim.
    if (reservation.claim.events.length === 0) {
      return { reservation, moreDeferred: false };
    }

    // Trust only the ACTUAL claimed events from here — never the preview that
    // produced `maxEvents`, which can already be stale (see doc comment).
    // Validated against `resolveChannelClaimFit` — the SAME predicate
    // `renderChannelEvent` uses — so a claim that fits under the full cap but
    // would still be shrunk by the renderer's marker-reserving repack (issue
    // #442, PR #442 round-3 review) is caught here too: `packChannelEventsUnderCap`
    // alone (no `moreDeferred` awareness) let such a claim through, so
    // `renderChannelEvent` silently dropped a committed block while
    // `meta.event_count` still reported the full committed count.
    // Reserve room for the ACTUAL claim's own coalesced reminder (issue #441,
    // PR #456 review finding 4) — reading it off `reservation.claim` (not the
    // earlier preview) is exact and immune to the preview↔reserve
    // substitution race the rest of this function guards against.
    const claimCap =
      MAX_CHANNEL_CONTENT -
      reminderFooterLength(reservation.claim.coalescedReminder);
    const fit = resolveChannelClaimFit(
      reservation.claim.events,
      moreDeferred,
      claimCap,
    );
    if (fit.fits) {
      // Re-check for the candidate-set-growth race (issue #442, PR #442
      // round-6/round-7 review): a settled event that arrived AFTER the
      // preview that sized this reservation, and is therefore not part of the
      // claim, still needs `moreDeferred: true` so the render signposts it —
      // even though this claim, taken on its own, fits and needed no
      // shrinking. Skipped once `moreDeferred` is already `true` (short
      // circuit) — a second preview would be redundant.
      let revalidatedMoreDeferred = moreDeferred;
      if (!moreDeferred) {
        try {
          revalidatedMoreDeferred = await settledWorkRemainsBeyondClaim(
            boundSession,
            socketPath,
            reservation.claim.events,
          );
        } catch (error) {
          // The post-reservation preview itself failed (daemon hiccup mid-poll,
          // issue #442 round-7 review): release the reservation BEFORE
          // propagating, or the leased rows stay claimed-in-limbo until the 30s
          // reservation TTL even though this reservation was never committed —
          // no other transport (hook path, next poll) could see them either.
          await releaseDeliveryClient(reservation.reservationId, socketPath);
          throw error;
        }
      }
      if (!revalidatedMoreDeferred) {
        return { reservation, moreDeferred };
      }
      // `moreDeferred` flipped to `true` AFTER this claim was already accepted
      // against the ORIGINAL (pre-flip) value: `resolveChannelClaimFit` sizes
      // against `cap` when `moreDeferred` is `false` but against
      // `cap − CHANNEL_DEFERRED_MARKER.length` once it's `true` (marker room
      // must be reserved) — the SAME predicate `renderChannelEvent` uses. A
      // claim that fit under the wider `false` budget can therefore no longer
      // fit once marker room is reserved for the newly-`true` value (issue
      // #442, PR #442 round-7 review): recompute the fit against the FINAL
      // `moreDeferred` before trusting it, exactly as the initial fit check
      // above did for the original value.
      const finalFit = resolveChannelClaimFit(
        reservation.claim.events,
        true,
        claimCap,
      );
      if (finalFit.fits) {
        return { reservation, moreDeferred: true };
      }
      // No longer fits under the marker-reserving budget: release (rows return
      // to pending — nothing lost) and retry through the SAME mismatch path
      // below, tightening the cap to what was just measured.
      await releaseDeliveryClient(reservation.reservationId, socketPath);
      forcedCap = Math.max(1, finalFit.includedCount);
      continue;
    }

    // Mismatch: the actually-claimed set does not fit. Release it (the rows
    // return to pending — nothing is lost) and retry, tightening the cap to
    // what was just measured. Unlike the push-failure release in
    // `runChannelDeliveryCycle` (best-effort there, since the reservation
    // self-expires after a rejected push either way), a release failure HERE
    // must PROPAGATE: if it silently swallowed and the release actually
    // failed, the oversized reservation would stay leased while this loop
    // discards its id — a later `reserveDelivery` can then come back `null`
    // (nothing else pending) even though those rows are unavailable until
    // lease expiry, and the cycle would report `'idle'` rather than
    // surfacing the failure (issue #442, PR #442 round-3 review). This
    // matches the documented contract that reserve/commit/release IPC errors
    // propagate to the caller.
    await releaseDeliveryClient(reservation.reservationId, socketPath);
    forcedCap = Math.max(1, fit.includedCount);
  }
  // Unreachable: the final (`isLastAttempt`) iteration above always returns,
  // since a single-event claim's fit is always ≥ its own length. Kept only to
  // satisfy the return type.
  return null;
}

/**
 * One reserve → push → confirm → commit/release delivery cycle for a bound
 * session (006 §4.5.1, §4.5.2; issues #300, #535).
 *
 * A resolved push is not evidence that anything surfaced: a host that loaded
 * the channel server without a channel listener drops the event and still
 * reports success (006 §12.6). The cycle therefore commits only on **host
 * confirmation**:
 *
 * 1. Mint a delivery id and start a confirmation with `confirmer` BEFORE
 *    reserving. If there is no confirmer, or it has no usable evidence source
 *    for this session, nothing is reserved or pushed
 *    (`'no-confirmation-source'`) — the hook path delivers.
 * 2. Reserve the pending `turn-interruptible` delivery, which leases the rows
 *    so the hook transport will not double-surface them (006 §4.5).
 * 3. Push the claim with its delivery id. A rejected push RELEASES the
 *    reservation (`'push-failed'`).
 * 4. Wait for the host to confirm this push. Confirmed → COMMIT (the rows
 *    become claimed, deduped from the hook path). Not confirmed within the
 *    bound → RELEASE (`'unconfirmed'`): the rows return to pending and the
 *    hook path delivers them. A late confirmation can at most duplicate a
 *    delivery, never lose one (PP1).
 *
 * The rows are never acknowledged by this path (BP2); a committed claim only
 * means "the host accepted it into the session".
 *
 * **Bounded reservation (006 §5.5, issue #442).** {@link
 * reserveSizedChannelDelivery} sizes (and, if the preview↔reserve race leaves
 * an oversized or mismatched claim, re-sizes) the reservation so the claimed
 * set equals the rendered set; `push` receives `moreDeferred` so the renderer
 * can signpost that more is pending.
 *
 * Reserve/commit IPC errors propagate to the caller (the poll loop maps them
 * to "daemon unreachable → drop the cached session"); push rejection and
 * missing confirmation are handled here, not thrown. Release after a failed or
 * unconfirmed push is best-effort: if it also fails, the reservation
 * self-expires. `push` and `confirmer` are the seams the tests inject to drive
 * every path without a live Claude Code host.
 */
export async function runChannelDeliveryCycle(
  boundSession: string,
  socketPath: string,
  push: (
    claim: DeliveryClaim,
    moreDeferred: boolean,
    deliveryId: string,
  ) => Promise<void>,
  confirmer?: ChannelPushConfirmer,
): Promise<ChannelDeliveryOutcome> {
  const deliveryId = mintChannelDeliveryId();
  const pending = confirmer?.begin(deliveryId);
  if (!pending) return 'no-confirmation-source';

  const sized = await reserveSizedChannelDelivery(boundSession, socketPath);
  if (!sized) return 'idle';
  const { reservation, moreDeferred } = sized;
  const release = (): Promise<unknown> =>
    releaseDeliveryClient(reservation.reservationId, socketPath).catch(
      () => undefined,
    );

  try {
    await push(reservation.claim, moreDeferred, deliveryId);
  } catch {
    // Push rejected/disconnected: NEVER commit — committing an unsurfaced
    // claim is the delivery-loss bug this cycle exists to prevent.
    await release();
    return 'push-failed';
  }

  // A confirmer that throws has proven nothing: treat it as unconfirmed.
  const confirmed = await pending.wait().catch(() => false);
  if (!confirmed) {
    await release();
    return 'unconfirmed';
  }

  // commit returns null when the reservation was already gone (the daemon
  // restarted, or the lease expired): the host has the event, but the rows were
  // never claimed, so they stay eligible for re-delivery (at-least-once).
  const committed = await commitDeliveryClient(
    reservation.reservationId,
    socketPath,
  );
  return committed === null ? 'surfaced-uncommitted' : 'surfaced';
}

/**
 * The MCP `instructions` string advertised by the channel server. Exported so
 * the parity test in `channel-ack.test.ts` can prove this fourth surface never
 * drifts from {@link LEASED_ROW_EXCEPTION} the way the schema hint's stale
 * wording once did (PR #445 review, round 13).
 */
export const CHANNEL_SERVER_INSTRUCTIONS =
  'AgentMon delivers monitor events here as <channel source="agentmonitors" ...>. ' +
  'Read each one and act on the work it describes. The tag meta carries urgency, ' +
  'event_count, and (for a single event) monitor_id and event_id. When you have ' +
  'handled events, call the agentmon_ack tool with their event_id values (or no ' +
  `arguments to acknowledge all unread, ${LEASED_ROW_EXCEPTION}).`;

/**
 * Collaborators the channel server's inbound tool handlers depend on.
 */
export interface ChannelToolHandlerDeps {
  /** Resolves (opening if needed) the tracked session this channel is bound to. */
  resolveSession: () => Promise<string>;
  /** Daemon socket the `events.ack` round trip is sent to. */
  socketPath: string;
}

/**
 * Registers the channel server's inbound MCP request handlers: `tools/list`
 * advertising `agentmon_ack`, and `tools/call` routing it through `events.ack`.
 *
 * This is the single place the channel server binds request schemas, shared by
 * `runChannelServe` and the Zod-runtime guard test, so that test exercises the
 * schemas the server really registers rather than a copy of them.
 */
export function registerChannelToolHandlers(
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level Server is intentional, see runChannelServe
  server: Server,
  deps: ChannelToolHandlerDeps,
): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [ACK_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
      const boundSession = await deps.resolveSession();
      // events.ack only touches rows projected to this session, so passing the
      // bound session id is the "outbound gate" that re-authorizes the ids (006 §4.3).
      await acknowledgeEventsClient(
        boundSession,
        parsed.args.eventIds,
        deps.socketPath,
      );
      const text = buildAckResultText(parsed.args.eventIds);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Acknowledge failed: ${message}` }],
        isError: true,
      };
    }
  });
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
  // Reject a bad interval before anything else runs. Socket resolution reads
  // local state, can warn on stderr about an overlong --socket path, and can
  // probe a legacy daemon socket, so it must come after this check; so must
  // the MCP handshake. Commander supplies the default as a string, so an
  // omitted flag parses as DEFAULT_POLL_MS here too.
  const parsedPollMs = parseIntegerOption(
    '--poll-ms',
    options.pollMs,
    CHANNEL_POLL_MS_RANGE,
  );
  if (!parsedPollMs.ok) {
    reportError(parsedPollMs.message, false);
    return;
  }
  const pollMs = parsedPollMs.value;

  const hostSessionId =
    options.hostSessionId ?? process.env['CLAUDE_CODE_SESSION_ID'];
  const workspace = options.workspace ?? process.env['CLAUDE_PROJECT_DIR'];
  const socketPath = resolveChannelSocketPath(options.socket, workspace);

  // The low-level Server is the correct API for a channel: it exposes the custom
  // `notification()` and the `experimental['claude/channel']` capability that the
  // high-level McpServer (tools/resources) does not. This is the "advanced use
  // case" the deprecation notice points to, and what the reference channels use.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
  const mcp = new Server(
    // Report the real package version, never a literal: this string is what a
    // host (and anyone reading an MCP handshake log) uses to identify which
    // build is serving the session, and a frozen `0.0.0` makes every release
    // indistinguishable from every other.
    { name: 'agentmonitors', version: getCliVersion() },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: CHANNEL_SERVER_INSTRUCTIONS,
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
  registerChannelToolHandlers(mcp, { resolveSession, socketPath });

  await mcp.connect(new StdioServerTransport());

  // Without a host session id we cannot bind to a session. Stay connected (the
  // ack tool reports an error if called), but do not poll.
  if (!hostSessionId) {
    process.stderr.write(
      'agentmonitors channel: no CLAUDE_CODE_SESSION_ID available; not binding to a session.\n',
    );
    return;
  }

  // Transport heartbeat (issue #425). `channel serve` is a long-lived process
  // that FREEZES its environment — HOME, CLAUDE_PROJECT_DIR, the resolved
  // socket, the CLI binary — at session start, and keeps looking connected long
  // after any of them stops matching reality. Refreshing this record every poll
  // is what lets `doctor` say "your channel is bound to workspace X / socket Y /
  // version Z" instead of the silence that hid the 2026-07-18 misbinding.
  //
  // `startedAt` is captured once here so the record distinguishes "running
  // since session start" from "respawned seconds ago" across refreshes.
  const startedAt = new Date();
  const heartbeatInput = {
    transport: 'channel' as const,
    workspacePath: workspace ?? process.cwd(),
    socketPath,
    ...(hostSessionId ? { hostSessionId } : {}),
  };
  // Track the last delivery across refreshes: each write is a whole record, so
  // omitting this would erase a previously-reported delivery on the next poll.
  let lastDeliveryAt: Date | undefined;
  // Whether this process's pushes are proven to reach the session (006
  // §4.5.2). Reported in every heartbeat so `doctor`/`verify` can say
  // confirmed / unproven from evidence rather than from "connected".
  const route = new ChannelRoute();
  // The Claude adapter's evidence source: the session transcript a hook
  // recorded for this host session.
  const confirmer = createTranscriptConfirmer(hostSessionId);
  // Set the instant EOF/shutdown begins (before the heartbeat record is
  // removed) and checked by every heartbeat write below. Without this, a poll
  // already in flight when EOF arrives settles AFTER the EOF handler removes
  // the heartbeat file, and its unconditional post-poll `heartbeat()` (below)
  // recreates the very record the clean-shutdown path just deleted — a
  // shut-down server would then read as "still listening" for the rest of the
  // TTL (issue #425 review, round 3).
  let shuttingDown = false;
  const heartbeat = (): void => {
    if (shuttingDown) {
      return;
    }
    writeTransportHeartbeat({
      ...heartbeatInput,
      startedAt,
      ...(sessionId ? { sessionId } : {}),
      ...(lastDeliveryAt ? { lastDeliveryAt } : {}),
      channelRoute: route.snapshot(),
    });
  };
  // Write immediately on startup, before the first poll: a channel server that
  // can never reach its daemon must still be visible as "running but misbound"
  // rather than absent — the absent case reads as "no channel at all", which
  // points at the wrong fix entirely.
  heartbeat();

  // Independent refresh timer, NOT gated on the poll settling (issue #425
  // review). Refreshing only from inside `poll` ties this transport's
  // liveness signal to the daemon IPC's latency: a daemon wedged for longer
  // than `CHANNEL_HEARTBEAT_TTL_MS` would let a live, correctly-bound server
  // lapse to `heartbeat-stale` — blaming the TRANSPORT for the DAEMON's
  // outage, exactly the mis-attribution `poll`'s own post-settle refresh
  // (below) already avoids for the reserve/commit/release IPC itself. A third
  // of the TTL comfortably re-arms the lease well before it could expire, and
  // is independent of how long any single poll's round trip takes.
  const heartbeatTimer = setInterval(
    heartbeat,
    Math.floor(CHANNEL_HEARTBEAT_TTL_MS / 3),
  );
  heartbeatTimer.unref();

  const recordOutcome = (outcome: ChannelDeliveryOutcome): void => {
    switch (outcome) {
      case 'idle':
        return;
      case 'no-confirmation-source':
        route.noEvidenceSource();
        return;
      case 'push-failed':
        route.unconfirmed('push-failed');
        return;
      case 'unconfirmed':
        route.unconfirmed('unconfirmed-push');
        process.stderr.write(
          'agentmonitors channel: the host did not confirm a push; the hook path delivers for the rest of this channel process.\n',
        );
        return;
      case 'surfaced':
      case 'surfaced-uncommitted':
        // Both mean the host confirmed it holds the event; only the durable
        // claim differs.
        lastDeliveryAt = new Date();
        route.confirmed(lastDeliveryAt);
        if (outcome === 'surfaced-uncommitted') {
          // Rare: confirmed, but the reservation lapsed before commit, so the
          // rows stay eligible for re-delivery (at-least-once). stdout is the
          // JSON-RPC channel and must not be written to.
          process.stderr.write(
            'agentmonitors channel: push confirmed but commit did not land; rows remain eligible for re-delivery.\n',
          );
        }
        return;
    }
  };

  const poll = async (): Promise<void> => {
    try {
      const boundSession = await resolveSession();
      // Unproven for the rest of this process after an unconfirmed push: the
      // hook path delivers everything, exactly as in hooks-only mode (006
      // §4.5.2), and nothing is reserved here.
      if (route.canPush) {
        const outcome = await runChannelDeliveryCycle(
          boundSession,
          socketPath,
          (claim, moreDeferred, deliveryId) => {
            const { content, meta } = renderChannelEvent(claim, {
              moreDeferred,
              socketPath,
            });
            return mcp.notification({
              method: 'notifications/claude/channel',
              params: {
                content,
                meta: { ...meta, [CHANNEL_DELIVERY_ID_META_KEY]: deliveryId },
              },
            });
          },
          confirmer,
        );
        recordOutcome(outcome);
      }
    } catch {
      // Reserve/commit/release IPC failed → daemon unreachable / socket missing:
      // the hook-state transport still delivers durably (006 §7), and any
      // reservation we couldn't release self-expires. Drop the cached session id
      // and retry.
      sessionId = undefined;
    }
    // Refresh AFTER the poll settles, on the success and failure paths alike: a
    // server that cannot reach its daemon is still alive and still bound, and
    // reporting it as stale would blame the transport for the daemon's outage —
    // two different problems with two different fixes.
    heartbeat();
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
    // Set BEFORE removing the record: an in-flight poll's `await` may still be
    // pending and its `finally`-style post-settle `heartbeat()` call happens
    // after this handler returns, so the guard must already be up before the
    // record is deleted, or that later call recreates it.
    shuttingDown = true;
    if (timer) {
      clearTimeout(timer);
    }
    clearInterval(heartbeatTimer);
    // Remove the heartbeat on a clean shutdown so `doctor` reports "no channel"
    // immediately rather than "stale channel" for the whole TTL — the two point
    // at different fixes. An unclean death (SIGKILL, host crash) leaves the
    // record behind, which is exactly what the TTL is for.
    removeTransportHeartbeat('channel', heartbeatInput);
    void mcp.close();
  });
}
