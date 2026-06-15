---
'@agentmonitors/core': patch
---

Align the generated `urgency` JSON Schema pattern with the Zod parser's whitespace tolerance. The parser trims surrounding whitespace before validating (so `urgency: ' normal '` and `' normal .. high '` are accepted), but the generated editor-hint schema previously rejected leading/trailing whitespace. The pattern now allows it (`^\s*…\s*$`), so schema-based validation and the authoritative parser agree.
