## 2026-11-15 — Refuse uncertain Linux libc before native loading (003 §11.2; 008 §3.3) — Refs #640

Linux native admission reads the running process's mapped libraries once before
requiring the vendored binary. A mapped glibc filename is required, and any musl
loader/libc mapping refuses even alongside glibc compatibility files. Unreadable,
empty or ambiguous evidence refuses with `glibc is required`; static Node without
mapped libc is deliberately unsupported. No diagnostic report or subprocess runs.
The post-load glibc symbol check remains a second consistency check. VM tests
verify admission order and non-Linux isolation; provenance tests verify both
packaged copies and their digests.

