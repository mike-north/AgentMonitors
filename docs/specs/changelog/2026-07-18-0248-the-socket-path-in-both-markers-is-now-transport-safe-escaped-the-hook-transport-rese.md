## 2026-07-18 — The socket path in both markers is now transport-safe-escaped, the hook transport reserves/validates/commits instead of claiming directly, and its two markers can co-render (006 §4.2.1, §5.1, §5.5) — Refs #442

Three fixes found on this PR's round-8 review.

- **A raw socket path could reintroduce forbidden tag-breakout characters into the channel's
  `content`.** The marker's socket path was interpolated AFTER `contentValue`'s tag-safety
  sanitization pass had already run (it is appended directly, not re-sanitized), and the prior
  `shellQuoteSingle` helper preserves every byte literally inside single quotes — so an explicit
  socket path containing `<`/`>`/`[`/`]` (or a raw CR/backtick) reintroduced those bytes unescaped
  into the pushed `<channel>` body, violating §4.6. Replaced by `escapeShellPath`
  (`delivery-event-render.ts`), shared by both transports: it renders the path in bash/zsh ANSI-C
  quoting (`$'...'`), hex-escaping (`\xNN`) every byte outside a conservative safe set
  (`[A-Za-z0-9/._-]`) — no forbidden byte can survive raw, while the path still reconstructs exactly
  when the advertised command is run. A path containing only safe bytes still renders as a plain,
  more-readable single-quoted token (no escaping needed). Verified end to end: the channel integration
  test now uses an adversarial-but-filesystem-legal socket path (spaces + brackets) and actually
  executes the advertised recovery command via a real shell against the live daemon.
- **A hook-deliver claim could be irreversibly claimed and then have its render silently drop a
  block.** `previewSettledHighDeliveryClient` (sizing) and `claimDeliveryClient` (the sized claim)
  are two separate IPC round-trips, so a concurrent caller could substitute different, larger pending
  events into the same requested count — passing the count check but overflowing the render's own
  repack. Because `claimDelivery` sets `first_notified_at` synchronously, the dropped tail of an
  already-claimed row could never redeliver. Fixed by switching `hook deliver` to the same
  reserve → validate-fit → commit/release pattern the channel transport already uses: it now reserves
  (leases, does not claim), re-validates the ACTUAL reserved claim's fit via the new
  `resolveHookClaimFit` (the same predicate `renderHookDelivery` itself uses), and only commits once
  the fit is confirmed — releasing and retrying (bounded, forward-progress-guaranteed) on a mismatch.
- **The mixed case (a sole claimed event that is itself oversized, AND further different work
  genuinely stays pending) silently dropped one of the two real signals.** `renderHookDelivery`'s
  mid-truncation branch rendered only the claimed-unread marker even when `moreDeferred` was also
  true, so an agent had no way to know a separate, still-pending remainder existed and would
  redeliver. Both markers now render together whenever both conditions hold — they describe
  non-overlapping facts and neither implies the other.

006 §5.1, §4.2.1, and the changeset for #436/#442 previously described only the socketless, unsplit
recovery command; both are now corrected to match the shipped, split-marker, socket-and-session-scoped
contract, including the mixed claimed-truncation + deferred-remainder case.

