# sources/api-poll — design notes (non-normative)

## Authoring guidance: noisy rendered HTML

`text-diff` is the correct strategy for a web page, but rendered HTML is often a noisy input: many real
status pages embed per-request timestamps, CSRF tokens, nonces, or build metadata, so the raw body
differs on every poll with no user-visible status change. For status-page monitoring, authors should
prefer a machine-readable endpoint when one exists (for example a Statuspage-style
`/api/v2/status.json`), because JSON summary endpoints are generally stable until the status itself
changes. When only rendered HTML is available, authors should expect noise and pair the monitor with a
`notify.strategy: debounce` window where appropriate.

## Why non-2xx is an error for body-diffing strategies

Baselining on an error body makes a misconfigured monitor appear to work: it baselines on, then diffs,
error pages with no signal that auth or the URL is broken (issue #220: a bad token produced `HTTP 401`
yet the monitor validated and observed "successfully"). `status-code` is the deliberate exception
because the status transition is the watched object.

## Why the bounds exist (issue #304)

A stalled or huge endpoint must not wedge a tick, delay unrelated monitors, exhaust daemon memory, or
amplify the local SQLite database (daemon availability). Each bound closes a distinct gap:

- The single deadline timer covers the whole exchange because a server can send headers promptly and
  then stall or trickle a chunked body.
- `Content-Length` is checked early as an optimization only; the streamed count is the authority
  because the header can be absent or wrong.
- The per-part cap bounds one body and the 5-worker pool bounds how many are in flight, but neither
  bounds the assembled composite; the cumulative rendered budget closes that.
- The part-count and part-`id` caps exist because a reviewer showed 100,000 empty-body parts produced a
  1,699,998-byte baseline and a single empty-body part with an 11 MiB `id` produced an 11,534,340-byte
  baseline without tripping a body-only budget: framing (`## <id>\n`) is paid regardless of body size.
  The part-count cap also turns worst-case composite tick duration into a known ceiling
  (`ceil(parts / 5) * timeout`).
