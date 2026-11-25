---
'@agentmonitors/cli': patch
---

Reject malformed and out-of-range daemon timer, verification timeout, and monitor row-limit options before accessing runtime state. Preserve omitted defaults and `--reap-after-ms 0`, and report exact format-aware diagnostics.
