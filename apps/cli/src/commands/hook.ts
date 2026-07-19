import { Command, Option } from 'commander';
import type {
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryLifecycle,
  DeliveryReservation,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import {
  claimDeliveryClient,
  commitDeliveryClient,
  diagnoseHookDeliveryClient,
  listSessionsClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import {
  MAX_ADDITIONAL_CONTEXT,
  packEventsUnderCap,
  renderHookDelivery,
  resolveHookClaimFit,
  type HookDeliveryOutput,
} from '../hook-deliver-render.js';
import { readHookPayload } from '../hook-payload.js';
import {
  isManualDaemonConnectionError,
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';
import {
  describeCapDeferral,
  describeClaim,
  describeCommitLapsed,
  describeDaemonUnreachable,
  describeDiagnosisFailure,
  describeHolds,
  describeInternalError,
  describeLifecycle,
  describeNoSessionId,
  describeNoSessionMatch,
  describeNoSocket,
  describeOutput,
  describePayload,
  describeSessionMatch,
  describeUnmappedLifecycle,
  describeUnreadCounts,
  describeWorkspace,
  describeWorkspaceDisabled,
} from '../hook-deliver-debug.js';
import {
  describeMalformedPayloadWarning,
  describeUnknownHostSessionWarning,
  describeUnmappedLifecycleWarning,
} from '../hook-deliver-warnings.js';

export const hookCommand = new Command('hook').description(
  'Claim hook-delivery payloads from the runtime',
);
type HookClaimLifecycle = DeliveryLifecycle;

hookCommand
  .command('claim')
  .description('Claim a pending delivery payload for a session')
  .requiredOption('--session <id>', 'AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--lifecycle <lifecycle>', 'Lifecycle point (required)')
      .choices(['turn-interruptible', 'turn-idle', 'post-compact'])
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('json'),
  )
  .action(
    async (options: {
      session: string;
      socket?: string;
      lifecycle: HookClaimLifecycle;
      format: string;
    }) => {
      try {
        const claim = await claimDeliveryClient(
          options.session,
          options.lifecycle,
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(claim, null, 2));
          return;
        }
        if (!claim) {
          console.log('No pending delivery.');
          return;
        }
        console.log(claim.message);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
      }
    },
  );

/**
 * Map a Claude Code hook event to the AgentMon {@link DeliveryLifecycle} it
 * should claim at. Only events that actually honor
 * `hookSpecificOutput.additionalContext` are mapped — i.e. the **context
 * events** `UserPromptSubmit`, `SessionStart`, and `PostToolUse`. Any other
 * event (including `PreToolUse`, which uses `permissionDecision`, and `Stop`,
 * which uses a top-level `decision`) returns `undefined`, so the command emits
 * nothing — injecting additionalContext there would be ignored by the host.
 *
 * @see https://code.claude.com/docs/en/hooks.md — JSON Output → "Context events
 *   (SessionStart, PostToolUse): use hookSpecificOutput.additionalContext".
 */
function lifecycleForEvent(
  hookEventName: string | undefined,
): DeliveryLifecycle | undefined {
  switch (hookEventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'turn-interruptible';
    case 'SessionStart':
      return 'post-compact';
    default:
      return undefined;
  }
}

/**
 * Upper bound on how many times {@link reserveSizedHookDelivery} will
 * reserve → discover an actual-claim size mismatch → release → retry before
 * forcing a single-event reservation (issue #442, PR #442 round-8 review).
 * Mirrors the channel transport's `MAX_CHANNEL_RESERVE_ATTEMPTS`
 * (`commands/channel.ts`) — same rationale, same bound.
 */
const MAX_HOOK_RESERVE_ATTEMPTS = 3;

/** The result of a successful {@link reserveSizedHookDelivery} call. */
export interface SizedHookDelivery {
  reservation: DeliveryReservation;
  moreDeferred: boolean;
  /**
   * The settled high-urgency preview count at the moment this reservation was
   * accepted — only meaningful (and only used) for the `--debug`
   * `describeCapDeferral` line when `moreDeferred` is true. `undefined` when
   * no preview was taken (non-`turn-interruptible` lifecycles, or a reminder
   * claim).
   */
  previewCount: number | undefined;
}

/**
 * Whether settled high-urgency work remains pending BEYOND the events this
 * attempt just reserved (issue #442, PR #442 round-9 review — "candidate-set
 * growth" race, mirroring the channel transport's
 * `settledWorkRemainsBeyondClaim` in `channel.ts`).
 *
 * A `moreDeferred` computed only from the preview that PRECEDED this
 * reservation can go stale in the OTHER direction from the substitution race
 * {@link reserveSizedHookDelivery} already re-sizes for: the preview held
 * exactly as many events as `maxEvents` (say, one), so `moreDeferred` was
 * computed `false` — but a SECOND event settles (crosses the 15s debounce
 * boundary) in the gap between that preview and the `reserve` call. The
 * reservation legitimately contains only the first event and fits under the
 * cap, so {@link resolveHookClaimFit}'s fit check reports `fits: true` — that
 * check only asks "does the RESERVED set fit", never "is there MORE settled
 * work than what got reserved". Left unchecked, `hook deliver` would render
 * with no deferred marker even though the second, now-settled event stays
 * pending — contrary to §5.5 ("the render omits any pending event ...
 * signposting that more updates are pending").
 *
 * Re-runs the SAME read-only preview {@link reserveSizedHookDelivery} itself
 * uses for sizing and compares it against the actually-reserved event ids — a
 * settled event that is NOT in the reservation means genuine deferred work
 * remains.
 */
async function settledWorkRemainsBeyondClaim(
  sessionId: string,
  socketPath: string,
  reservedEvents: DeliveryEventSummary[],
): Promise<boolean> {
  const reservedIds = new Set(reservedEvents.map((event) => event.eventId));
  const stillSettled = await previewSettledHighDeliveryClient(
    sessionId,
    socketPath,
  );
  return stillSettled.some((event) => !reservedIds.has(event.eventId));
}

/**
 * Reserve — but do NOT yet claim — the delivery for `sessionId`/`lifecycle`,
 * sizing a `turn-interruptible` body-injection claim to fit the hook-deliver
 * `additionalContext` cap and RE-VALIDATING that fit against the ACTUALLY
 * reserved claim before the caller ever commits it (issue #442, PR #442
 * round-8 review). Also re-validates `moreDeferred` itself against a
 * post-reservation preview (issue #442, PR #442 round-9 review) — see
 * {@link settledWorkRemainsBeyondClaim}.
 *
 * **Why re-validate at all.** `previewSettledHighDeliveryClient` (sizing) and
 * `reserveDeliveryClient` (reservation) are two SEPARATE IPC round-trips, so
 * the events the reservation actually returns can differ from the ones the
 * preview measured — most dangerously a **substitution**: a concurrent caller
 * claims/leases the previewed rows first, and the reservation instead fills
 * the same requested *count* from different, larger pending events whose
 * block sizes were never measured by that preview. The prior code claimed
 * directly on the unvalidated count (`claimDeliveryClient(..., fit)`): a
 * substituted, larger set would pass the COUNT check but still fail
 * `renderHookDelivery`'s own repack — and because `claimDelivery` sets
 * `first_notified_at` synchronously, the truncated-away tail of an
 * already-claimed row can **never redeliver** (§5.5's core guarantee, broken).
 *
 * **The fix.** Reserve first (leasing the rows — no durable claim yet), then
 * check the REAL reserved claim's fit via {@link resolveHookClaimFit} — the
 * SAME predicate `renderHookDelivery` uses to decide whether/how much it must
 * cut. A mismatch releases the reservation (the rows return to `pending`;
 * nothing is lost, since nothing was ever claimed) and retries with a
 * tightened cap — mirroring the channel transport's
 * `reserveSizedChannelDelivery` (`commands/channel.ts`) exactly. Bounded by
 * {@link MAX_HOOK_RESERVE_ATTEMPTS}; the final attempt forces `maxEvents: 1`,
 * which is always whole (a single-event claim's own block may still exceed
 * the cap, but `renderHookDelivery`'s mid-truncation backstop handles that
 * pathological case — see its doc comment), so this always terminates.
 *
 * **Scope.** Only a `turn-interruptible` BODY-INJECTION claim carries the
 * count/size risk this guards against — the per-event block cap only applies
 * there (issue #299). A reminder claim (`events: []`) is a single coalesced
 * `message`, not assembled from a variable number of per-event blocks, so
 * there is nothing for a substitution race to drop; `turn-idle`/`post-compact`
 * need no sizing either (the recap self-heals by re-showing all unread each
 * time, §5.5). Both are reserved with no `maxEvents` and accepted directly.
 *
 * Returns `null` when nothing is pending to reserve (mirrors `reserveDelivery`
 * returning `null`).
 */
export async function reserveSizedHookDelivery(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath: string,
): Promise<SizedHookDelivery | null> {
  let forcedCap: number | undefined;
  for (let attempt = 1; attempt <= MAX_HOOK_RESERVE_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_HOOK_RESERVE_ATTEMPTS;
    let maxEvents: number | undefined;
    let moreDeferred = false;
    let previewCount: number | undefined;

    if (lifecycle === 'turn-interruptible') {
      const highPreview = await previewSettledHighDeliveryClient(
        sessionId,
        socketPath,
      );
      previewCount = highPreview.length;
      if (isLastAttempt) {
        // Forward-progress fallback: repeated mismatches mean sizing keeps
        // racing with reservation. Force a single event so THIS attempt
        // cannot fail to make progress.
        maxEvents = 1;
        moreDeferred = highPreview.length > 1;
      } else if (highPreview.length > 0) {
        let fit = packEventsUnderCap(
          highPreview,
          sessionId,
          undefined,
          socketPath,
        );
        if (forcedCap !== undefined) fit = Math.min(fit, forcedCap);
        fit = Math.max(1, fit);
        maxEvents = fit;
        moreDeferred = fit < highPreview.length;
      } else if (forcedCap !== undefined) {
        // A prior attempt proved a smaller cap was needed, but this preview
        // raced empty — still force the known-safe cap so a freshly settled
        // event can't slip back in unbounded.
        maxEvents = forcedCap;
      }
    }

    const reservation = await reserveDeliveryClient(
      sessionId,
      lifecycle,
      socketPath,
      maxEvents,
    );
    if (!reservation) return null;

    // A reminder claim carries no event bodies to size against, so a
    // `moreDeferred` computed from the settled-high PREVIEW describes that
    // stale preview, not this claim: the preview↔reserve race let another
    // transport lease/claim those previewed rows first, and `reserveDelivery`
    // legitimately falls back to a reminder even though the preview saw
    // settled-high rows and set `moreDeferred` from them. `renderHookDelivery`
    // never consults `moreDeferred` for an eventless claim either way (its
    // `claim.events.length === 0` branch renders the reminder `message`
    // as-is) — but `--debug`'s `describeCapDeferral` line DOES read it (see
    // `hook.ts`'s `deliver` action), so a stale `true` here would emit a
    // "cap deferral" diagnostic for a claim that carries no cap-truncated
    // events at all. Clear it, mirroring the channel transport's identical
    // fix (`reserveSizedChannelDelivery`, `channel.ts`) (issue #442, PR #442
    // round-10 review).
    if (reservation.claim.events.length === 0) {
      return { reservation, moreDeferred: false, previewCount };
    }

    // Any non-`turn-interruptible` lifecycle carries no per-event sizing risk
    // either (see doc comment above) — accept directly, `moreDeferred` as
    // computed (always `false` for these lifecycles; see the `if
    // (lifecycle === 'turn-interruptible')` guard above).
    if (lifecycle !== 'turn-interruptible') {
      return { reservation, moreDeferred, previewCount };
    }

    // Trust only the ACTUAL reserved events from here — never the preview
    // that produced `maxEvents`, which can already be stale (substitution).
    // Validated against `resolveHookClaimFit` — the SAME predicate
    // `renderHookDelivery` uses — so a claim that would still be shrunk by
    // the renderer's marker-reserving repack is caught here too, before any
    // durable claim is made.
    const fit = resolveHookClaimFit(
      reservation.claim.events,
      sessionId,
      socketPath,
      moreDeferred,
      MAX_ADDITIONAL_CONTEXT,
    );
    if (fit.fits) {
      // Re-check for the candidate-set-growth race (issue #442, PR #442
      // round-9 review): a settled event that arrived AFTER the preview that
      // sized this reservation, and is therefore not part of the reservation,
      // still needs `moreDeferred: true` so the render signposts it — even
      // though this reservation, taken on its own, fits and needed no
      // shrinking. Skipped once `moreDeferred` is already `true` (short
      // circuit) — a second preview would be redundant.
      let revalidatedMoreDeferred = moreDeferred;
      if (!moreDeferred) {
        try {
          revalidatedMoreDeferred = await settledWorkRemainsBeyondClaim(
            sessionId,
            socketPath,
            reservation.claim.events,
          );
        } catch (error) {
          // The post-reservation preview itself failed (daemon hiccup
          // mid-poll, mirroring channel.ts's round-7 review fix): release the
          // reservation BEFORE propagating, or the leased rows stay
          // claimed-in-limbo until the reservation TTL even though this
          // reservation was never committed — no other transport (channel
          // path, next context event) could see them either.
          await releaseDeliveryClient(reservation.reservationId, socketPath);
          throw error;
        }
      }
      if (!revalidatedMoreDeferred) {
        return { reservation, moreDeferred, previewCount };
      }
      // `moreDeferred` flipped to `true` AFTER this reservation was already
      // accepted against the ORIGINAL (pre-flip) value: `resolveHookClaimFit`
      // sizes against `cap` when `moreDeferred` is `false` but against
      // `cap − <deferred marker length>` once it's `true` (marker room must
      // be reserved) — the SAME predicate `renderHookDelivery` uses. A claim
      // that fit under the wider `false` budget can therefore no longer fit
      // once marker room is reserved for the newly-`true` value: recompute
      // the fit against the FINAL `moreDeferred` before trusting it, exactly
      // as the initial fit check above did for the original value.
      const finalFit = resolveHookClaimFit(
        reservation.claim.events,
        sessionId,
        socketPath,
        true,
        MAX_ADDITIONAL_CONTEXT,
      );
      if (finalFit.fits) {
        return { reservation, moreDeferred: true, previewCount };
      }
      // No longer fits under the marker-reserving budget: release (rows
      // return to pending — nothing lost) and retry through the SAME
      // mismatch path below, tightening the cap to what was just measured.
      await releaseDeliveryClient(reservation.reservationId, socketPath);
      forcedCap = Math.max(1, finalFit.includedCount);
      continue;
    }

    // Mismatch: the actually-reserved set does not fit. Release it (the rows
    // return to pending — nothing is lost, since nothing was ever claimed)
    // and retry, tightening the cap to what was just measured.
    await releaseDeliveryClient(reservation.reservationId, socketPath);
    forcedCap = Math.max(1, fit.includedCount);
  }
  // Unreachable: the final (isLastAttempt) iteration above always returns,
  // since a single-event claim's fit is always whole. Kept only to satisfy
  // the return type.
  return null;
}

/** The result of {@link reserveRenderAndCommitHookDelivery}. */
export interface HookDeliveryFlowResult {
  /** The rendered payload, or `null` when there is genuinely nothing to surface. */
  output: HookDeliveryOutput | null;
  /** Whether more settled high-urgency work remains pending beyond this delivery. */
  moreDeferred: boolean;
  /**
   * The settled high-urgency preview count at the moment this reservation
   * was accepted (see {@link SizedHookDelivery.previewCount}) — for
   * `--debug`'s `describeCapDeferral` line only.
   */
  previewCount: number | undefined;
  /** The reservation's own (not-yet-committed) claim `output` was rendered from — for `--debug` only. */
  reservedClaim: DeliveryClaim;
  /**
   * Commit the reservation this `output` was rendered from, marking the rows
   * durably claimed (`first_notified_at`). **Callers MUST call this only
   * AFTER `output` has been successfully written** (or immediately, when
   * `output` is `null` — there is nothing to write) — see the ordering
   * rationale on {@link reserveRenderAndCommitHookDelivery}. Returns the
   * committed claim, or `null` if the reservation's lease already expired (a
   * safe no-op: the rows re-deliver later via the ordinary context-event
   * flow, and duplicate delivery — not loss — is the safe direction here).
   */
  commit: () => Promise<DeliveryClaim | null>;
  /**
   * Release the reservation WITHOUT claiming — the rows return to pending.
   * Callers use this when writing `output` failed: nothing was durably
   * surfaced, so nothing should be durably claimed (issue #442, PR #442
   * round-9 review).
   */
  release: () => Promise<void>;
}

/**
 * Reserve, re-validate, RENDER, then hand the caller a `commit` callback to
 * invoke only after the rendered `output` has been successfully written
 * (issue #442, PR #442 round-9 review — an at-most-once loss window).
 *
 * **The bug this closes.** The prior flow committed the reservation
 * (`commitDeliveryClient` — the durable `first_notified_at` mutation) BEFORE
 * any hook output was rendered or written to stdout. If the daemon applied
 * the commit but its RPC response was lost, or if rendering/stdout writing
 * failed afterward, the surrounding try/catch (the hook's always-exit-0
 * contract) swallowed the error and emitted nothing — while the rows were
 * PERMANENTLY excluded from ordinary redelivery (`pendingEventsForSession`
 * never returns an already-claimed row, §5.5). That is an at-most-once loss
 * window: the delivery could vanish with no user-visible signal and no path
 * back except the durable-but-unread copy via `agentmonitors events list`.
 *
 * **The fix.** Render the already-validated `reservation.claim` FIRST — this
 * function does that immediately, using the reservation's claim, never a
 * committed one — and return a `commit` closure the caller invokes only once
 * it has successfully written that output. If the write never happens (a
 * render/output failure), the caller releases the reservation instead (the
 * rows return to pending, nothing durably claimed — see `hook.ts`'s
 * `deliver` action). Once the write has succeeded, `commit` itself can land
 * on one of three outcomes, never a loss either way since the output was
 * already written by the time commit is attempted: a **non-null** resolve
 * means the row is durably claimed and will not redeliver; a **null**
 * resolve means the reservation's lease already lapsed — the row was
 * definitely never claimed, so it stays pending and WILL redeliver on the
 * next context event; a **rejection** (an IPC/transport error) is neither —
 * the daemon may have applied the commit before the response was lost, so
 * whether the row ends up claimed or still pending is genuinely UNCERTAIN,
 * making a LATER DUPLICATE delivery merely the safe possibility, not a
 * guarantee.
 *
 * Mirrors the channel transport's reserve → push → commit ordering
 * (`runChannelDeliveryCycle`, `channel.ts`) — same rationale (never durably
 * consume a delivery before it is actually surfaced), applied to the hook
 * transport's synchronous stdout write instead of a fallible MCP push.
 */
export async function reserveRenderAndCommitHookDelivery(
  sessionId: string,
  lifecycle: DeliveryLifecycle,
  socketPath: string,
  hookEventName: string,
): Promise<HookDeliveryFlowResult | null> {
  const sized = await reserveSizedHookDelivery(
    sessionId,
    lifecycle,
    socketPath,
  );
  if (!sized) return null;
  const output = renderHookDelivery(sized.reservation.claim, hookEventName, {
    moreDeferred: sized.moreDeferred,
    socketPath,
  });
  return {
    output,
    moreDeferred: sized.moreDeferred,
    previewCount: sized.previewCount,
    reservedClaim: sized.reservation.claim,
    commit: () =>
      commitDeliveryClient(sized.reservation.reservationId, socketPath),
    release: () =>
      releaseDeliveryClient(sized.reservation.reservationId, socketPath),
  };
}

/**
 * Write `flow.output` (when non-null) via the caller-supplied `write`, awaiting
 * its FULL completion, THEN commit — or, if `write` throws (synchronously OR
 * by rejecting), RELEASE the reservation instead of committing (issue #442,
 * PR #442 rounds 9-10 review). This is the enforcement point for
 * {@link reserveRenderAndCommitHookDelivery}'s ordering contract: a failed
 * write means nothing was durably surfaced, so nothing gets durably claimed
 * either — the rows return to pending and redeliver normally. A
 * failed/uncertain `commit` (the write already succeeded) is NOT caught
 * here: it propagates to the caller. A rejected/uncertain commit CAN
 * produce a later duplicate delivery, if the commit in fact never applied —
 * but it cannot lose this surface, because the write already completed
 * before commit was attempted (the output already reached the user).
 *
 * **Why `write` must be awaited, not just called.** `process.stdout.write`'s
 * synchronous return value (`true`/`false`) is a BACKPRESSURE signal, not a
 * success signal — it says whether the internal buffer is full, not whether
 * the bytes ever reached the pipe. A write can return `true` synchronously
 * and STILL fail asynchronously (e.g. `EPIPE` when the reading end — Claude
 * Code's hook consumer — has already closed its end of the pipe) after this
 * function has already returned and the caller has already committed. That
 * reopens exactly the at-most-once loss window the round-9 fix closed: the
 * commit lands, but the bytes never arrived. `write`'s CALLBACK (or a
 * subsequent `'error'` event on the stream) is the only authoritative
 * completion signal either way — see `deliver`'s call site below, which
 * promisifies `process.stdout.write(chunk, callback)` and races it against
 * the stream's `'error'` event for the case an error arrives instead of (or
 * racing) the callback.
 *
 * Extracted as its own function so it is independently testable against a
 * `write` seam that can be made to reject (simulating a delayed/async pipe
 * failure), without needing the full CLI action's stdin/socket/session
 * plumbing.
 */
export async function writeAndCommitHookDelivery(
  flow: HookDeliveryFlowResult,
  write: (output: HookDeliveryOutput) => void | Promise<void>,
): Promise<DeliveryClaim | null> {
  if (flow.output !== null) {
    try {
      await write(flow.output);
    } catch (writeError) {
      await flow.release();
      throw writeError;
    }
  }
  return flow.commit();
}

/**
 * Write `chunk` to `stream` and resolve only once the write has FULLY
 * completed — never on the synchronous `stream.write()` return value, which
 * signals backpressure (should the caller pause writing), not success (issue
 * #442, PR #442 round-10 review). A write can return `true` synchronously and
 * still fail asynchronously (e.g. `EPIPE`, the reading end already closed).
 *
 * Node's `Writable.write(chunk, callback)` invokes `callback` once the chunk
 * is fully handled — with an `Error` if the write failed, or no argument on
 * success — which is the authoritative completion signal this function
 * resolves/rejects on. It ALSO listens for the stream's own `'error'` event
 * (the failure signal an error emitted between the synchronous call and the
 * callback firing would otherwise be missed by, since a stream's `'error'`
 * event has no required correlation to any one pending `write()` call).
 *
 * **The callback and the event are NOT mutually exclusive on a real
 * `Writable`** (issue #442, PR #442 round-11 review): when the underlying
 * write fails, Node invokes the callback with the error AND separately
 * EMITS the paired `'error'` event on a later tick (`errorOrDestroy` /
 * `afterWriteTick`). An earlier version of this function removed its only
 * `'error'` listener as soon as the callback settled the promise, so that
 * paired emission had no listener left and became an uncaught exception —
 * three independent real-stream probes (a closed pipe's write, a spawned
 * child's closed stdin, and an `fs` write stream on a closed fd) reproduced
 * `callback EPIPE -> promise rejected -> uncaught EPIPE`, which could exit
 * the hook process nonzero despite its always-exit-0 contract.
 *
 * The fix: the `'error'` listener stays armed (via `once`, so it can fire at
 * most once) whenever the callback settles with an error, specifically so it
 * can swallow that later paired event instead of leaving it uncaught; the
 * listener is detached explicitly only on the paths where no paired event
 * will ever follow — a successful write, or `stream.write()` itself throwing
 * synchronously (so the callback never fires and the listener would
 * otherwise never be cleaned up). Either the callback or the event may be
 * the FIRST signal to arrive; whichever is first settles/rejects the
 * returned promise exactly once.
 *
 * @see https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback
 * @see https://nodejs.org/api/stream.html#event-error
 */
export function writeStreamChunk(
  stream: NodeJS.WritableStream,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A plain `boolean` local would get narrowed to the literal `false` by
    // the time the `catch` block below runs (TS/eslint cannot prove the
    // write callback — which mutates it — ever runs synchronously before
    // then), tripping `no-unnecessary-condition` on a guard that IS
    // necessary once a real stream is involved. Boxing it in an object
    // sidesteps that false-positive narrowing.
    const state = { settled: false };
    const onStreamError = (error: Error): void => {
      if (state.settled) {
        // The write callback already settled this promise with the SAME
        // error; this is the paired 'error' event a real Writable emits on
        // a later tick. `once` has already unregistered this handler —
        // swallow it here so it can never become an uncaught exception.
        return;
      }
      state.settled = true;
      reject(error);
    };
    stream.once('error', onStreamError);
    try {
      stream.write(chunk, (writeError?: Error | null) => {
        if (writeError) {
          if (!state.settled) {
            state.settled = true;
            reject(writeError);
          }
          // Deliberately leave `onStreamError` attached: it must stay armed
          // to swallow the paired 'error' event this same failure emits on
          // a later tick (see doc comment above).
          return;
        }
        if (state.settled) return;
        state.settled = true;
        // No error was reported, so no paired 'error' event will follow —
        // detach now rather than leaking the listener onto later writes.
        stream.removeListener('error', onStreamError);
        resolve();
      });
    } catch (syncError) {
      // stream.write() threw synchronously: the callback will never fire,
      // so no paired event is coming either — detach to avoid leaking the
      // listener forever.
      if (!state.settled) {
        state.settled = true;
        stream.removeListener('error', onStreamError);
        reject(syncError as Error);
      }
    }
  });
}

hookCommand
  .command('deliver')
  .description(
    'Claim pending events and emit advisory hook context at a turn boundary',
  )
  .addOption(
    new Option(
      '--lifecycle <lifecycle>',
      'Optional override; normally the lifecycle is derived from the firing event',
    ).choices(['turn-interruptible', 'turn-idle', 'post-compact']),
  )
  .addOption(
    new Option(
      '--format <format>',
      'Output format; default/json emit hook wire JSON, text emits advisory context only',
    ).choices(['text', 'json']),
  )
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--debug',
    'Write a diagnosis of why nothing was (or was) delivered to STDERR; ' +
      'STDOUT is byte-identical to a non-debug run in every mode (issue #334)',
  )
  .addHelpText(
    'after',
    `
Emission preconditions:
  Requires an enabled project, a per-workspace socket in .claude/agentmonitors.local.md
  (or --socket), a reachable daemon, and a matching tracked session for the hook payload session_id.
  Empty output means nothing is pending or this workspace/session is not configured.

Output formats:
  default/json  Compact Claude Code hook wire JSON when something is pending.
  text          Rendered additionalContext only, for manual inspection.

Always-on STDERR diagnostics (issues #329, #420):
  Three failure branches whose empty STDOUT is otherwise indistinguishable from
  "nothing pending" — and which never resolve on their own — ALWAYS write one line to
  STDERR, even without --debug. STDOUT and the exit code are unaffected:
    - malformed / non-hook payload (no session_id):
        hook deliver: no session_id in the stdin payload — ...
    - hook_event_name that maps to no delivery lifecycle:
        hook deliver: hook_event_name "<name>" does not map to a delivery lifecycle ...
    - session_id that matches no tracked session:
        hook deliver: no session registered for host session id "<id>"
  The expected (and silent) ~15s high-urgency claim-settle window still writes nothing.

Diagnosis:
  --debug  Writes a step-by-step diagnosis to STDERR only (session resolution,
           workspace/socket state, unread (unacknowledged) event counts by urgency, and the hold
           reason for anything not yet deliverable: settle window, already-claimed,
           coalesced-until-ack, or deferred-by-cap). STDOUT never changes.
`,
  )
  .action(
    async (options: {
      lifecycle?: DeliveryLifecycle;
      socket?: string;
      format?: 'text' | 'json';
      debug?: boolean;
    }) => {
      const debugEnabled = options.debug === true;
      const debug = (msg: string): void => {
        if (debugEnabled) process.stderr.write(`${msg}\n`);
      };

      // This command is invoked by Claude Code hooks.  ANY failure MUST be
      // silent on STDOUT (print nothing, exit 0) — surfacing an error there
      // would disrupt the user's session.  All IPC / resolution work is
      // wrapped in try/catch so no unhandled rejection can propagate. Debug
      // diagnosis writes ONLY to stderr and never alters this contract.
      try {
        // Claude Code delivers hook input as JSON on STDIN (not env vars).
        const payload = await readHookPayload();
        debug(describePayload(payload));

        // No session_id in the payload means this is not a real Claude Code
        // hook call, or the payload is malformed/empty. Emit a one-line stderr
        // diagnostic ALWAYS (issue #420 P1) — like the unknown-session branch
        // below (#329), the empty stdout is otherwise indistinguishable from
        // "nothing pending," and this failure never self-resolves. STDOUT and
        // the exit code are untouched. The plugin only wires this command into
        // events that carry a session_id, so this fires only on the manual path.
        const hostSessionId = payload.session_id;
        if (!hostSessionId) {
          process.stderr.write(`${describeMalformedPayloadWarning()}\n`);
          debug(describeNoSessionId());
          return;
        }

        // Derive the lifecycle from the firing event unless explicitly
        // overridden. Events that do not honor additionalContext map to
        // `undefined` → quiet no-op (emitting context there is useless).
        const hookEventName = payload.hook_event_name;
        const lifecycle = options.lifecycle ?? lifecycleForEvent(hookEventName);
        if (!lifecycle) {
          // additionalContext at an unmapped event would be silently ignored by
          // the host, so empty stdout is mistaken for "nothing pending." Emit a
          // one-line stderr diagnostic ALWAYS (issue #420 P1); STDOUT and the
          // exit code are untouched. Only reachable on the manual path — the
          // plugin wires this into UserPromptSubmit, which maps.
          process.stderr.write(
            `${describeUnmappedLifecycleWarning(hookEventName)}\n`,
          );
          debug(describeUnmappedLifecycle(hookEventName));
          return;
        }
        debug(
          describeLifecycle(
            lifecycle,
            options.lifecycle !== undefined,
            hookEventName,
          ),
        );

        // Resolve the socket: explicit flag → .local.md socket → give up.
        // The workspace comes from the payload's cwd, then CLAUDE_PROJECT_DIR,
        // then the process cwd.
        const workspacePath =
          payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
        const state = readLocalState(workspacePath);
        debug(describeWorkspace(workspacePath, state.enabled, state.socket));
        if (!state.enabled) {
          debug(describeWorkspaceDisabled(workspacePath));
          return;
        }

        // Require an EXPLICIT per-workspace socket (flag or `.local.md`). If
        // neither is present, bail rather than letting resolveSocketPath fall
        // back to AGENTMONITORS_SOCKET / the global default — that could connect
        // this workspace's hook to a different workspace's daemon, breaking
        // per-workspace isolation.
        const explicitSocket = options.socket ?? state.socket;
        if (!explicitSocket) {
          debug(describeNoSocket());
          return;
        }
        // Only a literal --socket flag is "explicit" for the substitution
        // warning (issue #337) — a socket read from .local.md is a derived
        // value the daemon itself chose at boot, not a user-typed request.
        const socketPath = resolveSocketPath(explicitSocket, {
          explicit: options.socket !== undefined,
        });

        if (!(await daemonAvailable(socketPath))) {
          debug(describeDaemonUnreachable(socketPath));
          return;
        }

        // Resolve the host session id to an AgentMon session record. Unlike
        // every other quiet-return branch above, an unresolvable session_id
        // is otherwise indistinguishable from the expected high-urgency
        // claim-settle window (up to ~15s of legitimately empty output,
        // 002 §9.1) — so this ONE branch always writes a one-line stderr
        // diagnostic, regardless of --debug (issue #329). STDOUT is
        // untouched either way.
        const sessions = await listSessionsClient(socketPath);
        const match = sessions.find((s) => s.hostSessionId === hostSessionId);
        if (!match) {
          process.stderr.write(
            `${describeUnknownHostSessionWarning(hostSessionId)}\n`,
          );
          debug(describeNoSessionMatch(hostSessionId, sessions));
          return;
        }
        debug(describeSessionMatch(match));

        // Pending-by-urgency counts + per-band hold reasons (issue #334). Pure
        // read (never claims/mutates); computed ONLY when --debug is set, so
        // the non-debug path makes no extra daemon round trip.
        if (debugEnabled) {
          try {
            const diagnosis = await diagnoseHookDeliveryClient(
              match.id,
              lifecycle,
              socketPath,
            );
            debug(describeUnreadCounts(diagnosis));
            for (const holdLine of describeHolds(diagnosis)) debug(holdLine);
          } catch (diagnosisError) {
            debug(describeDiagnosisFailure(diagnosisError));
          }
        }

        // Claim any pending deliveries for this session at this lifecycle
        // point.
        //
        // For a `turn-interruptible` high-urgency delivery the visible surface
        // is length-bounded (the 4000-char additionalContext, 006 §5.1), so we
        // must claim ONLY the events that actually fit — otherwise events
        // truncated out of the render would be marked claimed and never
        // re-delivered (issue #299). This is a RESERVE → validate-fit →
        // RENDER → WRITE → COMMIT sequence, not a direct sized claim (issue
        // #442, PR #442 rounds 8-9). `previewSettledHighDeliveryClient`
        // (sizing) and the eventual reservation are two separate IPC
        // round-trips, so the events actually returned can differ from the
        // ones the preview measured (a concurrent caller substitutes
        // different, larger pending events into the same requested count).
        // Claiming directly on an unvalidated count would let a substituted,
        // oversized set pass the count check but then fail
        // `renderHookDelivery`'s own repack — and a synchronously-claimed
        // row's truncated-away tail can never redeliver.
        // `reserveSizedHookDelivery` re-validates the fit (and the
        // `moreDeferred` candidate-growth race) of the ACTUAL reserved claim
        // (never the stale preview) before anything here commits, releasing
        // and retrying on a mismatch (mirroring the channel transport's
        // `reserveSizedChannelDelivery`/`resolveChannelClaimFit`).
        //
        // Crucially, the COMMIT — the durable `first_notified_at` mutation
        // that permanently excludes these rows from ordinary redelivery — now
        // happens AFTER the rendered output is successfully written, never
        // before (issue #442, PR #442 round-9 review): committing first left
        // an at-most-once loss window where a lost commit-RPC response, or a
        // render/write failure AFTER commit, would durably consume the
        // delivery while emitting nothing. Rendering off the RESERVATION's
        // own claim (never a committed one) and deferring commit until after
        // a successful write means a write failure can still be recovered by
        // releasing the reservation (nothing durably claimed, rows stay
        // pending) — and a commit failure/uncertainty after a successful
        // write only risks a later DUPLICATE delivery, the safe direction,
        // never a loss. Mirrors the channel transport's reserve → push →
        // commit ordering (`runChannelDeliveryCycle`, `channel.ts`).
        const flow = await reserveRenderAndCommitHookDelivery(
          match.id,
          lifecycle,
          socketPath,
          hookEventName ?? '',
        );

        if (!flow) {
          debug(describeClaim(null));
          debug(describeOutput(null, options.format));
          return;
        }

        const { output, moreDeferred, previewCount, reservedClaim } = flow;
        if (moreDeferred && previewCount !== undefined) {
          debug(describeCapDeferral(previewCount, reservedClaim.events.length));
        }
        debug(describeOutput(output, options.format));

        // Write (if there is anything to write) THEN commit — never the
        // reverse (issue #442, PR #442 round-9 review). The write itself is
        // awaited through its ACTUAL completion callback, not `stdout.write`'s
        // synchronous return value — a `true` return is only a backpressure
        // signal, and an `EPIPE` can still arrive asynchronously afterward
        // (issue #442, PR #442 round-10 review; see `writeStreamChunk`). A
        // write failure — synchronous OR the awaited async rejection — releases
        // the reservation instead of committing (nothing durably claimed; rows
        // stay pending) — see `writeAndCommitHookDelivery`.
        const claim = await writeAndCommitHookDelivery(flow, (toWrite) =>
          writeStreamChunk(
            process.stdout,
            options.format === 'text'
              ? toWrite.hookSpecificOutput.additionalContext
              : JSON.stringify(toWrite),
          ),
        );
        if (!claim) {
          // `commit()` resolved null: the reservation's lease expired before
          // commit could land (or the daemon restarted and dropped its
          // in-memory lease) — this is the definitely-uncommitted outcome,
          // not an uncertain one (a rejected/lost commit RPC instead
          // propagates as a thrown error to the outer catch below, since
          // whether that row is claimed is genuinely unknown, not resolvable
          // here). The output — if any — was already written, so this is a
          // safe, intentional duplicate: the rows return to pending and
          // re-deliver at the next context event (or via a concurrent
          // channel poll) rather than being lost.
          debug(describeCommitLapsed());
        }
        debug(describeClaim(claim ?? reservedClaim));
      } catch (error) {
        // Any internal error is swallowed: a hook that throws would interrupt
        // the user's session (BP2 / always-exit-0 contract). Debug mode still
        // names it on stderr — stdout stays untouched either way.
        debug(describeInternalError(error));
      }
    },
  );
