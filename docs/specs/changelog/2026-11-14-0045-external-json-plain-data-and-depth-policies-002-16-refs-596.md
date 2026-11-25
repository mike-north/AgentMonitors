## 2026-11-14 — External JSON plain-data and depth policies (002 §16) — Refs #596

Specify the internal external-event encoder independently of retained-retry
serialization. Accept null-prototype records and dense ordinary arrays; reject
array subclasses, proxies before reflection, unsafe values and unsupported own
properties. State inclusive container depth with caller-selected initial depth,
scalar leaves, and valid bounds. Encode members before canonical key sorting so
an early invalid value cannot inspect later members. Cover these rules with
boundary tables, deterministic generated permutations and early-refusal tests.
The package-root surface and retained-retry behavior remain unchanged.

