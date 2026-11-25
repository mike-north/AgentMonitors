---
'@agentmonitors/cli': patch
---

Distinguish unreachable daemons from written requests with unknown outcomes. Manual session,
event, claim and watch commands now exit 3 when no reply arrives after a request was written,
with inspection guidance for mutations. Monitor retry repairs also exit 3 for unknown outcomes.
