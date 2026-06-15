# @agentmonitors/core

## 0.8.0

### Minor Changes

- dfb124a: Monitor `urgency` frontmatter now accepts an authored band (`urgency: normal..high`); a bare scalar
  is the degenerate band `x..x`. A source observation may carry an optional `salience`, and the runtime
  resolves the effective urgency as `clamp(salience ?? band.lo, band.lo, band.hi)` — so a source can
  escalate a single observation only within the author's band, clamping outside it. An escalated
  observation arriving in a held debounce batch flushes the whole batch early (it is not split).

### Patch Changes

- 07f8cf7: Align the generated `urgency` JSON Schema pattern with the Zod parser's whitespace tolerance. The parser trims surrounding whitespace before validating (so `urgency: ' normal '` and `' normal .. high '` are accepted), but the generated editor-hint schema previously rejected leading/trailing whitespace. The pattern now allows it (`^\s*…\s*$`), so schema-based validation and the authoritative parser agree.

## 0.7.0

### Minor Changes

- 5c748a4: `daemon once` and the `daemon run` periodic tick log now report monitors whose `observe()` errored on a tick instead of printing a clean `emitted 0 event(s)`. The runtime tick result gains an `erroredObservations: { monitorId, message }[]` field (populated from the same path that records each `errored` row in `observation_history`), and the CLI surfaces a non-zero errored count plus each errored monitor's id and message without a verbose flag. A genuine no-change tick is unchanged, so an author can finally distinguish a broken source from a watched target that simply hasn't changed.
