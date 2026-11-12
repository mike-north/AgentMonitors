---
'@agentmonitors/core': patch
---

Open databases written by every released version. The rebuild that adds the private materialization order to stored events and snapshots now carries columns the current schema does not define, with their values, declared type and default, instead of dropping them. An index or trigger that reads such a column no longer makes every open fail. A rebuild that cannot complete names the table and column that stopped it and leaves the database unchanged.
