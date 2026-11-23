---
'@agentmonitors/cli': patch
'@agentmonitors/source-command-poll': patch
---

Refuse Linux native execution before loading the binding when mapped libraries do not establish glibc or include musl. Unreadable or ambiguous evidence fails closed without diagnostic reports or subprocesses.
