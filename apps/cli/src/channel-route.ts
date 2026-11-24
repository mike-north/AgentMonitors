/**
 * What one `channel serve` process knows about whether its pushes reach the
 * session (006 §4.5.2).
 *
 * The route starts **unproven**. Only a push the host confirmed proves it. An
 * unconfirmed push — or a push that failed outright — marks the route unproven
 * for the rest of the process, and the channel stops pushing real deliveries:
 * a session without a listener is not re-pushed every poll, and a session
 * whose evidence cannot be read does not see each event twice. The hook path
 * delivers everything meanwhile, exactly as in hooks-only mode. A new process
 * starts unproven again.
 *
 * "No evidence source yet" (no transcript path recorded, or the file is not
 * there) is not sticky: nothing was pushed, so the route stays open to its
 * first real attempt once a hook records the path.
 */

/** Whether a push from this process has been confirmed by the host. */
export type ChannelRouteState = 'confirmed' | 'unproven';

/**
 * Why the route is in its current state:
 *
 * - `no-push-yet` — nothing has been pushed by this process yet.
 * - `no-transcript` — no usable session transcript to confirm against, so the
 *   channel is not pushing.
 * - `unconfirmed-push` — the host did not confirm a push within the bound
 *   (typically: the channel was loaded without a listener).
 * - `push-failed` — a push call itself failed.
 * - `confirmed-push` — the last push was confirmed.
 */
export type ChannelRouteEvidence =
  | 'no-push-yet'
  | 'no-transcript'
  | 'unconfirmed-push'
  | 'push-failed'
  | 'confirmed-push';

/** A serialisable snapshot of the route, as the heartbeat reports it. */
export interface ChannelRouteSnapshot {
  state: ChannelRouteState;
  evidence: ChannelRouteEvidence;
  /** When this process last had a push confirmed (ISO 8601), if ever. */
  lastConfirmedAt?: string;
}

/** The per-process route state machine. */
export class ChannelRoute {
  #state: ChannelRouteState = 'unproven';
  #evidence: ChannelRouteEvidence = 'no-push-yet';
  #lastConfirmedAt: Date | undefined;
  #stopped = false;

  /** Whether this process may still push real deliveries. */
  get canPush(): boolean {
    return !this.#stopped;
  }

  /** No usable evidence source this cycle; nothing was pushed. */
  noEvidenceSource(): void {
    if (this.#stopped || this.#state === 'confirmed') {
      // Losing the source after a confirmed push is still a route that can no
      // longer be confirmed: stop, like any other unconfirmed push.
      if (this.#state === 'confirmed') this.#stop('no-transcript');
      return;
    }
    this.#evidence = 'no-transcript';
  }

  /** The host confirmed a push. */
  confirmed(at: Date): void {
    if (this.#stopped) return;
    this.#state = 'confirmed';
    this.#evidence = 'confirmed-push';
    this.#lastConfirmedAt = at;
  }

  /** A push went unconfirmed or failed: unproven for the rest of the process. */
  unconfirmed(evidence: 'unconfirmed-push' | 'push-failed'): void {
    this.#stop(evidence);
  }

  #stop(evidence: ChannelRouteEvidence): void {
    this.#stopped = true;
    this.#state = 'unproven';
    this.#evidence = evidence;
  }

  snapshot(): ChannelRouteSnapshot {
    return {
      state: this.#state,
      evidence: this.#evidence,
      ...(this.#lastConfirmedAt
        ? { lastConfirmedAt: this.#lastConfirmedAt.toISOString() }
        : {}),
    };
  }
}
