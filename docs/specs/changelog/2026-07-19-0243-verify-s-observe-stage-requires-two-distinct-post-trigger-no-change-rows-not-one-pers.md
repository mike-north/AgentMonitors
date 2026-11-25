## 2026-07-19 — `verify`'s observe stage requires two distinct post-trigger `no-change` rows, not one persisting (005 §16 step 6, Budget) — Refs #442

`verify`'s observe stage previously fail-fast on a single post-trigger `no-change` observation-history
row once it had merely _persisted_ for a full monitor interval — the same guard mechanism as the
`suppressed` debounce carve-out, but applied to a single row re-read on every poll rather than to
genuinely new evidence. A daemon tick already in flight (mid-scan) when the trigger fired can finish
and record its necessarily-stale, pre-trigger `no-change` row _after_ the trigger's timestamp under
enough scheduling delay (a busy CI runner); every subsequent poll then re-reads that SAME retained
row, and once one wall-clock interval passed, that persistence alone was wrongly treated as decisive
— even though the next genuine post-trigger tick could still finish and observe the real change
later. It also under-budgeted: the default detect budget (interval + margin, ~37.5s for the
file-fingerprint default) could not fit both the default detect window AND an extra full-interval
persistence wait, so a genuine no-change case could report `budget-exceeded` instead of the documented
`no-change` verdict.

Fixed: a `no-change` verdict now requires **two distinct observation-history rows** (different ids),
both reporting `no-change` after the trigger, before it is decisive — a single stale row, however long
it lingers, never reaches that bar; a `triggered` row still wins immediately regardless. The pure
discriminator is extracted into `apps/cli/src/verify-observe.ts` (`resolveObserveVerdict`,
`resolveObserveDeadline`) so it is unit-testable independent of the daemon-backed integration path.
`verify-budget.ts`'s `VerifyBudget` gained `noChangeConfirmMs` (`2 × interval + margin`, no settle
term) — the observe stage's deadline is extended to at least this value, but **only** when using the
default derived budget; an explicit `--timeout-ms` is honored as the operator's real cap and is never
silently extended, so a timeout shorter than one interval still fails fast with `budget-exceeded`. 005
§16 step 6 and its Budget section now document both the two-distinct-row rule and the conditional
deadline extension.

