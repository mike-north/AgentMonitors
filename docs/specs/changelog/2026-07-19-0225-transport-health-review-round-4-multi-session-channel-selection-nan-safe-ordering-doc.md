## 2026-07-19 — Transport-health review round 4: multi-session channel selection, NaN-safe ordering, documented `pipelineProblems` (005 §15) — Refs #425

Three ways the surface could still have issued a **false clean bill of health**, all closed:

- **A broken session hidden behind a healthy sibling.** The channel entry was derived from the
  freshest matching heartbeat alone. With two registered leads — one healthy channel, one bound to
  the wrong workspace — that reported delivery as healthy while a live session silently received
  nothing. It now evaluates EVERY heartbeat matching an active lead, unions their problems (each
  prefixed with the host session id, since "the channel is misbound" is unactionable without saying
  which session), and picks as representative the record with the MOST problems, ties broken by
  freshness.
- **A channel adopted from someone else's session.** A channel matching no active lead session was
  falling back to any same-workspace record and being reported as this session's healthy, deliverable
  transport — including when the workspace had no lead sessions at all. Such a record is still
  _shown_ (a reader diagnosing silence needs to know a server is running) but now carries
  `channel-session-unmatched` and can never count toward `deliveryWillReachThisSession`. The
  workspace fallback remains correct for the session-less hook transport, and only there.
- **A corrupt timestamp outranking a valid record.** Ordering used `Date.parse` directly; the
  registry is untrusted and only proves `updatedAt` is a _string_, so `NaN` was reachable and made
  the comparator inconsistent. Unparseable timestamps now sort as oldest.

`pipelineProblems[]` is also now documented in the canonical `--json` shape, including _why_ it
duplicates the per-transport copies: either can be read alone and be correct, and only the top-level
list is present when no transport is configured — exactly the case where a muted or daemon-less
workspace would otherwise look merely idle.

