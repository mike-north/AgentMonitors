---
'@agentmonitors/source-file-fingerprint': patch
---

Keep file fingerprints, snapshots and checkpoints consistent during concurrent saves. Sample contents once and reject reads whose file metadata changes, preserving the previous baseline for the next observation.
