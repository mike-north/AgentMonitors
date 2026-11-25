## 2026-11-05 — Preserve physical lookup and explicit POSIX PATH components (004 §2.7) — Refs #520

Launcher discovery uses native physical file and directory identities before lexical joins can change symlink/`..` traversal. Explicit empty POSIX PATH components retain discovery-time cwd, while unset PATH does not; unusable directories are skipped so later valid entries remain discoverable.

