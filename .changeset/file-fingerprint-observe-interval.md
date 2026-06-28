---
'@agentmonitors/cli': patch
'@agentmonitors/source-file-fingerprint': patch
---

Surface the file-fingerprint observe interval in source metadata and CLI source listing.

The file-fingerprint source schema now documents the `watch.interval` knob and its 30s default, and
`agentmonitors source list` includes per-field descriptions so authors can see that the interval is
tunable without reading source code.
