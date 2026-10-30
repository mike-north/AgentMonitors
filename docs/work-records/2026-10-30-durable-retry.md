# Durable retry outbox review repairs

Scope: existing PR #483 at `c02a88db54126ecfb4cd532901c77b2fa83730e3`. This storage primitive
is the next layer after #482. Runtime adoption, retry lifecycle transitions, diagnostic commands,
and closing #295 remain downstream work. No canonical checkout changes were used.

## Reproduced findings

Tests written before implementation reproduced three accepted-value conversions:

- negative zero persisted as positive zero;
- an observedAt Date with its own toJSON hook persisted a different instant;
- JavaScript callers could supply an ISO string observedAt, which returned as a Date.

All now fail with MaterializationRetrySerializationError before any sibling write. The defined
persistable domain excludes negative zero and customized Dates (own properties or subclasses);
observedAt is required to be a valid unmodified Date. Date validation uses intrinsic operations
rather than caller-overridden methods; serialization converts the validated instant explicitly.
This rejects previously accepted lossy values rather than changing their meaning. The public input
TSDoc and spec now describe the narrowed supported domain; the original typed Observation payload
remains unknown, with a documented runtime domain error for unsupported data.

Two new overflow tests prove capacity atomicity: 255 existing records plus two same-route siblings,
and an existing byte total where either new sibling fits alone but their sum exceeds 8 MiB by one
byte. Both assert no surviving siblings; the row case includes a different-route sibling and the
byte case reopens the file-backed database. Existing admission logic passed these tests unchanged.

## Validation

Focused retry tests: 11 passed. Core strict TypeScript and API-report checks passed (API report
unchanged). Changed-file lint has no errors; existing release-tag warnings remain. Full-suite and
formatting results are recorded with the final handoff. Final merge authority remains with the
coordinator after an independent adversarial review of this repaired head.

Full core suite: 43 files, 623 tests passed on Node 24.14.0. Formatting and diff whitespace checks
passed. Rebased onto #482's independently reviewed candidate
`35393aea6b2a5b9999e4fb1568d48073153af1cb`; the parent change after the initial rebase was documentation
only. The reviewed #483 remote head has not been overwritten.

## Adversarial serialization repair

Independent review of `0f3b3c0f5cdfabb8f34b4960b8abc12db091f3cb` found a remaining
accepted-value change: nested proxies could synthesize an unvalidated toJSON hook after descriptor
validation. Route getters also ran before serialization rejected their accessor descriptors.
Two tests were added first and failed as expected (11 prior tests passed): proxy admission did not
throw, and a route getter ran once. The repaired domain explicitly excludes proxies via Node's
intrinsic check before reflection, including revoked proxies. Full envelope validation precedes
route reads. Cases cover root, payload, monitor route, timestamp, revoked proxies, and both trusted
route leaf accessors; they require zero hook calls and zero persisted siblings.

The prior reviewer authored this follow-up repair, so a different independent reviewer must review
the new candidate. No push or merge was performed.

Follow-up validation: 13 focused retry tests and all 625 core tests (43 files) pass on Node 24.14.0.
Core strict TypeScript, build/API report (unchanged), changed-file ESLint (0 errors; existing
release-tag warnings), formatting, and diff whitespace checks pass.
