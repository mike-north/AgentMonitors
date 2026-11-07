---
'@agentmonitors/core': patch
---

Select snapshot diff predecessors by durable SQLite materialization order across processes and clock changes. Preserve public snapshot IDs while migrating retained history to a private sequence. Preserve exact retained trigger SQL across coordinated event and snapshot rebuilds, including dependencies from other tables.
