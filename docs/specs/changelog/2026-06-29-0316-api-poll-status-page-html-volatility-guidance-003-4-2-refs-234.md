## 2026-06-29 — `api-poll` status-page HTML volatility guidance (003 §4.2) — Refs #234

Clarified that rendered HTML pages can be unsuitable `api-poll` inputs even when `text-diff` is
correctly inferred from `Content-Type`.

- **003 §4.2 — status-page caveat.** Many rendered status pages embed volatile per-request content
  such as timestamps, CSRF tokens, nonces, or build metadata. Raw `text-diff` can therefore fire on
  every poll even when service status has not changed.

- **Recommended authoring path.** Prefer machine-readable status endpoints when available, such as a
  Statuspage-style `/api/v2/status.json` URL. If only rendered HTML is available, expect noise and
  consider `notify.strategy: debounce`.

- **Authoring docs.** The `api-poll` section now includes a concrete JSON status endpoint example and
  explains why it is preferable for status-page monitoring.

