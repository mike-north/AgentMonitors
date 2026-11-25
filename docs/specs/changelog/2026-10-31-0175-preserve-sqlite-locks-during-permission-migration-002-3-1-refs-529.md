## 2026-10-31 — Preserve SQLite locks during permission migration (002 §3.1) — Refs #529

Move existing SQLite artifact tightening before connection creation. The previous
post-open descriptor closes released POSIX locks, allowing independent child writers
to leave a long-lived parent reading stale values and causing `SQLITE_PROTOCOL`
during concurrent access. Restricted umask still protects newly created artifacts.
Equivalent path spellings resolve to one physical database path for SQLite, target
artifact permissions, and the permission cache, so a second opener cannot repeat
migration while the first connection is live. File-symlink-first opens tighten the
actual target and its sidecars rather than caching an unverified target. Dangling
file aliases are rejected before target creation because they cannot provide a
stable canonical identity. Refs #529. Independent-process regressions require
successive committed values and normal writer exclusion; existing privacy tests remain.

