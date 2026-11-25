## 2026-07-16 — `doctor` survives version-skew daemons; a down daemon with a registered lead session fails instead of idling (005 §15) — Refs #382

Two follow-on bugfixes to `agentmonitors doctor`'s exit-code contract (§15), both discovered by
review after the #373 fix above.

- **Version-skew crash.** A still-running **older** daemon build that predates a request method the
  current CLI's schema knows about (e.g. `doctor.report` itself) can only reply with the socket
  protocol's legacy unparseable-request sentinel (`{ id: "invalid", error: "Invalid JSON request." }`).
  `doctor`'s daemon-vs-in-process fallback only recognized `DaemonConnectionError` (unreachable), so
  this sentinel surfaced as a fatal, user-visible crash instead of the intended graceful fallback to
  persisted state. Fixed in two parts: `callDaemon` (`apps/cli/src/daemon-ipc.ts`) now recognizes
  this exact sentinel — matched precisely on `id` **and** `error` text, never a substring/prefix
  check, so a genuine daemon-side application error is never misclassified — and raises a dedicated
  `DaemonUnsupportedRequestError` instead of a plain `Error`; going forward, a current daemon also
  attaches a machine-distinguishable `code: "unsupported_request"` alongside the unchanged legacy
  `id`/`error` pair (additive — an old client's schema simply ignores the new field, so a new daemon
  talking to an old client is unaffected). `doctor`'s fallback catch now accepts both
  `DaemonConnectionError` and `DaemonUnsupportedRequestError`, falling back to
  `doctorReportInProcess` for either.
- **Down daemon + registered lead session should fail, not idle.** `daemon-reachable`'s `idle`
  classification (added by the #373 fix) was previously unconditional — a down daemon was always
  `idle`, even when a lead session **is** registered for the workspace. But a registered lead session
  means an agent session is actually open right now; a down daemon in that state is not "nothing's
  open yet" (the case `idle` exists for) — it is almost certainly a mid-session daemon crash, a real
  problem that should not exit 0. `buildChecks` now classifies `daemon-reachable` as `fail` (not
  `idle`) precisely when `!daemonRunning && report.hasLeadSession`, with a `detail` naming the
  registered lead session instead of the "expected when no agent session is currently open" wording
  (which would be false in this state); the `idle` classification remains for the no-lead-session
  case. As a low-cost improvement in the same change, `daemon-reachable`'s `detail` also threads the
  underlying `DaemonConnectionError`/`DaemonUnsupportedRequestError` message through so a timeout
  ("daemon present but not answering") reads differently from no daemon process at all or a
  version-skewed daemon that rejected the request.
- **Verified by** `apps/cli/src/daemon-ipc.test.ts` (sentinel recognition, precise non-substring
  matching against a real application error, and the server-side `code` field) and
  `apps/cli/src/commands/cli.integration.test.ts` (`describe('doctor (issue #267)')`): a fake
  old-daemon server answering the legacy sentinel for `doctor.report` proves `doctor` falls back and
  exits 0 without ever printing the raw sentinel text; a real daemon killed while a lead session is
  registered proves `daemon-reachable` fails (exit 1) while `lead-session` itself still passes.

