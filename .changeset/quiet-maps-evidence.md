---
'@agentmonitors/cli': patch
'@agentmonitors/source-command-poll': patch
---

Require real glibc evidence before loading native command support on Linux. Synthetic or synthetic-looking mappings cannot establish glibc; musl-shaped path or label segments always refuse, including harmless synthetic labels beside real glibc. Ambiguous names deliberately cause refusal rather than admitting a non-glibc host.
