## 2026-11-05 — Resolve Corepack proxies and platform PATH semantics (004 §2.7) — Refs #520

Discover the requested manager through named Corepack proxies, honor exact POSIX `PATH` independently of Windows casing, and discover npm fixture tools separately from Node. The actual compatibility suite is exercised under separate Node/npm installations.

