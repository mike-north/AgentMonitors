## 2026-11-06 — Proven absence before location fallback (002 §4.6, 004 §2.5) — Refs #537

Clarify that boolean nonexistence is not proof of deletion: access or I/O failures can produce the
same result. Only metadata ENOENT/ENOTDIR permits replacing an admitted location with a valid
earlier location. Other failures preserve the original read diagnostic, held work and blocked
admission without starving siblings. Require actual POSIX permission/checkpoint/yield/reopen proof,
faithful filesystem fault controls, genuine moveback controls and narrow classification reversion.

