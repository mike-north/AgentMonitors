import { ulid } from 'ulid';
import type { DeliveryClaim, MonitorEventRecord } from './types.js';

/**
 * Default lifetime of an uncommitted delivery reservation, in milliseconds
 * (006 §4, issue #300).
 *
 * A reservation is held only for the span of a single channel push
 * (`mcp.notification()` — a local stdio round-trip that normally settles in
 * well under a second), then committed or released. This ceiling exists only to
 * self-heal the pathological case where the holder never does either — the
 * channel process crashes, or its push hangs on a broken transport that never
 * rejects — so the leased rows do not stay hidden from the hook transport
 * forever. It is deliberately far larger than any real push so a slow-but-valid
 * push still commits before the lease lapses, yet small enough that a crashed
 * reserve returns the rows to the hook path promptly.
 */
export const DEFAULT_DELIVERY_RESERVATION_TTL_MS = 30_000;

/**
 * The internal plan an uncommitted reservation carries so a later commit can
 * apply the SAME claim the reserve rendered (issue #300). Not part of the public
 * surface — the runtime hands transports only the {@link DeliveryClaim} and an
 * opaque `reservationId`.
 */
export interface DeliveryReservationPlan {
  sessionId: string;
  /**
   * The full candidate set a commit must mark claimed — representatives plus the
   * older `net` intermediates of each surfaced group — exactly what
   * `claimDelivery` would have claimed. Stored (not re-derived at commit) so the
   * committed set is precisely the set the push surfaced.
   */
  candidates: MonitorEventRecord[];
  /** True for the post-compact recap branch, whose commit also advances the recap cursor. */
  isRecap: boolean;
  /** The rendered claim returned to the transport at reserve time. */
  claim: DeliveryClaim;
  /** Epoch ms after which the lease is void and the rows return to the hook path. */
  expiresAt: number;
}

/**
 * In-memory registry of uncommitted delivery reservations (006 §4, issue #300).
 *
 * This is the "reserve → commit/release" half of the atomic surfacing protocol.
 * A transport (the channel, `apps/cli/src/commands/channel.ts`) reserves the
 * pending delivery, pushes it, and only THEN commits — so a rejected or
 * disconnected push never leaves rows permanently claimed. While a reservation
 * is outstanding its event ids are **leased**: the runtime hides them from the
 * claim decision so the hook transport does not double-surface them (the
 * cross-transport dedup boundary of 006 §4.5, moved to reserve time). A lease is
 * NOT acknowledgement and NOT a durable claim — it only defers the claim across
 * the push.
 *
 * The registry is intentionally **in-memory and daemon-local**: both transports
 * drive the one daemon runtime (006 §6.1), so an in-process map is sufficient to
 * mediate them, and losing it on a daemon restart is the SAFE direction — a
 * dropped lease simply returns its rows to `pending`, where the hook path
 * recovers them (never a lost delivery, PP1). Persisting a lease would instead
 * risk exactly the permanent-hide bug this fix removes.
 */
export class DeliveryReservationRegistry {
  private readonly reservations = new Map<string, DeliveryReservationPlan>();

  constructor(
    private readonly ttlMs = DEFAULT_DELIVERY_RESERVATION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a reservation over `candidates` and return its opaque id. The rows
   * are leased (hidden from the claim decision) until the reservation is
   * committed, released, or expires.
   */
  add(plan: Omit<DeliveryReservationPlan, 'expiresAt'>): string {
    const reservationId = ulid();
    this.reservations.set(reservationId, {
      ...plan,
      expiresAt: this.now() + this.ttlMs,
    });
    return reservationId;
  }

  /**
   * Remove and return a reservation for commit. Returns `undefined` if it is
   * unknown or already expired (a caller must then treat the delivery as not
   * committed — the rows may have re-delivered via the hook path).
   */
  take(reservationId: string): DeliveryReservationPlan | undefined {
    const plan = this.reservations.get(reservationId);
    this.reservations.delete(reservationId);
    if (!plan) return undefined;
    if (plan.expiresAt <= this.now()) return undefined;
    return plan;
  }

  /** Drop a reservation without committing it (a failed/abandoned push). */
  remove(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /**
   * The event ids currently leased for `sessionId` by any live (non-expired)
   * reservation. Expired reservations are pruned on access so a crashed reserve
   * self-heals. Returns an empty set when nothing is leased (the common case).
   */
  reservedEventIds(sessionId: string): Set<string> {
    const leased = new Set<string>();
    const nowMs = this.now();
    for (const [id, plan] of this.reservations) {
      if (plan.expiresAt <= nowMs) {
        this.reservations.delete(id);
        continue;
      }
      if (plan.sessionId !== sessionId) continue;
      for (const event of plan.candidates) leased.add(event.id);
    }
    return leased;
  }
}
