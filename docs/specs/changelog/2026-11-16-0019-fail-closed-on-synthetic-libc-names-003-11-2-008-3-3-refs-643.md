## 2026-11-16 — Fail closed on synthetic libc names (003 §11.2; 008 §3.3) — Refs #643

Synthetic or synthetic-looking mappings never establish glibc. Musl-shaped names
still refuse on every mapping, including slash-delimited path segments and
colon/bracket-delimited label segments in memfd, DMA-buffer, anonymous-inode and
bracketed names. Real paths under `/memfd:…/` or `/dmabuf:…/` cannot hide musl.
Harmless musl-shaped synthetic labels now refuse beside real glibc by design:
ambiguous text may cause needless refusal, never admission on a non-glibc host.
Injected maps tests cover both musl families, deleted suffixes and CR/U+2028/U+2029.

