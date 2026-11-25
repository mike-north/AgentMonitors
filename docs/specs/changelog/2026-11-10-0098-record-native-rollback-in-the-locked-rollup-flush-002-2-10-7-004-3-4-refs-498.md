## 2026-11-10 — Record native rollback in the locked rollup flush (002 §2, §10.7; 004 §3.4) — Refs #498

With the locked not-due rollup flush composed onto the native-rollback guard, a transaction-wide
`RAISE(ROLLBACK)` during a held window flush rethrows its original error through the tick's
monitor-local flush catch, which writes the single `errored` history row. The 002 history text no
longer says the not-due flush records no row or names the removed `materializeSpan()` path. Real
trigger coverage in `rollup-admission.test.ts` adds the held-flush ROLLBACK, the ABORT control, and
a hold captured before a parsed source edit. Previously, without the guard, the flush reported a
follow-on `COMMIT` error after writing a retry suffix and cleared hold outside the vanished
transaction, and retried old-source envelopes under the edited source. No public API change.

