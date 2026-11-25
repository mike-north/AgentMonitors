## 2026-11-16 — External envelope admission preserves safe state and RFC 3339 syntax (002 §2.6, §16.1)

Envelope admission refuses own `__proto__` keys throughout producer scope/state, including
nested array members, while general canonical JSON continues to preserve ordinary data keys.
Leap-second syntax accepts every UTC month end and equivalent offset spellings; timestamp
validation does not depend on a leap-second announcement table.

