## 2026-11-05 — Make physical PATH controls portable across POSIX utilities (004 §2.7) — Refs #520

Physical PATH controls now use owned non-JS shell executables and an explicit failing lexical decoy, preserving native lookup and literal argv assertions without depending on renamed host printf/false utilities.

