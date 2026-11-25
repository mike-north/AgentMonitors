## 2026-11-23 — Cover foreign exceptions at envelope admission catch sites (002 §16.1; 004 §6.1) — Refs #649

004 §6.1 now requires isolated coverage of each envelope admission catch site: envelope
byte preflight, scope byte preflight and canonical encoding. A counting proxy, an
ordinary object with counting coercion and inspection getters, and a native
stack-overflow `RangeError`, thrown there from a descriptor intrinsic installed before
import, must yield permanent `invalid_envelope` with no escape, no output and no
inspection of the thrown value. The ordinary object covers logging and `util.inspect`,
which format a proxy's target without running its traps. Validator behavior is unchanged; this records existing guarantees
as required scenarios.

