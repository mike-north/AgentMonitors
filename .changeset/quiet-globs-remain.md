---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'@agentmonitors/source-file-fingerprint': patch
---

Upgrade glob to 14.0.6 to fix moderate glob cancellation and minimatch pattern amplification advisories. Preserve monitor discovery and file-fingerprint matching for existing patterns, including directory filtering and default dotfile exclusion.
