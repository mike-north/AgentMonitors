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

## Prototype-chain validation repair

A different independent reviewer rejected `7ab1bed8f26af2d49d5b9d855bb22d3b115a8877` after
reproducing a remaining accepted-value conversion. A non-proxy object inherited a Proxy whose
`getPrototypeOf` trap ran during `instanceof Date`, changed the object's data, and replaced its
prototype with Object.prototype. Validation then accepted and stored the altered value. The
exact-SHA rejection and reproduction are recorded in the coordinator's
`2026-10-30-review-483-final.md` work record.

That reviewer was then assigned this repair. The regression was written first and failed
(13 existing tests passed); it now rejects root/payload/route objects, arrays, Date instances,
indirect proxy ancestors, and revoked proxy prototypes without trap calls or sibling writes.
Both Date checks now use Node's intrinsic brand predicate. Direct prototype identity checks,
intrinsic brands, and own-property descriptors cover classification without walking arbitrary
prototype chains. No clone is required within this supported domain: unsupported prototypes,
proxies, and accessors are rejected before any caller-defined reads. This remains a passive-data
contract rather than a security boundary against global intrinsic replacement or trusted
route-wrapper callbacks.

Validation: 14 focused retry tests and all 626 core tests across 43 files pass on Node 24.14.0.
Core strict TypeScript, build/API-report check (unchanged), changed-source ESLint (zero errors),
formatting, and whitespace checks pass. A new independent reviewer is required because this
reviewer authored the repair. No push or merge was performed.

## Intrinsic-state admission repair and supported-domain boundary

An independent reviewer rejected `3926706c275ba031c18f838a7145593dc108a528`: replacing only the
prototype of a Map, Set, or boxed Number let its internal data bypass the plain-prototype check
and be lost or changed in JSON. Nineteen parameterized tests were added first, each exercising
Object.prototype and null replacements. The pre-repair run had 16 failures and 17 passes: existing
hidden-property checks already rejected three brands, while sixteen additional brands were
accepted or failed with the wrong error.

Validation now excludes detectable internal-slot brands via Node's non-coercing intrinsic checks:
boxed primitives, maps/sets and weak variants, buffers/views, RegExp, native errors, promises,
map/set iterators, generators, arguments, module namespaces, and native externals. The existing
proxy/accessor/prototype-chain tests remain green. Node's isKeyObject/isCryptoKey wrappers were
not retained: unlike these intrinsic checks, they read symbol properties; an intermediate attempt
was caught by the existing revoked-proxy-prototype regression. Symbol-bearing objects remain
unsupported via descriptor inspection.

The coordinator explicitly accepted a bounded repair rather than an arbitrary-object serializer
redesign. The public input contract and 002 now distinguish the semantic supported domain from
early detection: callers must supply ordinary plain-data records/arrays; built-in/class instances
with replaced prototypes are still unsupported. JavaScript has no general intrinsic for erased
object provenance or unobservable private state. A prototype-stripped private-field class or some
platform objects (e.g. URL/URLSearchParams/AbortController) can look like empty records. They must
be normalized by their source, not treated as supported because validation passed. This does not
weaken the round-trip guarantee for supported ordinary records, but it corrects the previous
implication that runtime validation could authenticate every arbitrary same-process object.
Independent review must assess this boundary explicitly before integration.

Validation: all 33 retry tests and 645 core tests (43 files) pass; strict TypeScript, build/API-report
check (unchanged), changed-source ESLint (zero errors; existing release-tag warnings), formatting,
and whitespace checks pass. Re-running the independent reviewer's public harness preserves all
five positive rollback/reopen/round-trip/scope/refusal checks and now rejects Map/Set/Number with
the serialization domain error. No remote push or merge was performed. Rebase onto merged #482
is performed only after confirming the previous base and merged main have identical trees;
final replacement SHA and tree-equivalence evidence are in the handoff.
