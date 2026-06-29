---
applyTo: 'apps/**/*.ts,libs/**/*.ts,plugins/**/*.ts'
---

# Security And Secret-Handling Guidance

- When you redact or sanitize a sensitive value (credentials, API tokens, URLs
  carrying userinfo or query secrets, PII), apply that redaction to EVERY path
  the value can reach a human or a durable store — not just the one named in the
  ticket. Audit them all: thrown `Error` messages, log and warning output,
  persisted history or audit records (e.g. `observation_history`), tick and CLI
  output, and any title/summary/payload surfaced into a session.
- Concrete check: after adding redaction at one site, grep the module for every
  other use of the same variable inside a thrown, logged, persisted, or
  user-visible string and redact those too. A redaction that covers the warning
  but leaves the raw value in the adjacent error throw — which then persists to
  durable audit storage and fires on the common auth-failure path — is a worse
  leak than the one it fixed. Real example: `source-api-poll` redacted its
  `json-diff` warning URL but still embedded the raw credential-bearing URL in
  its non-2xx error message, which `recordObservationHistory` persisted.
- Make redaction helpers fail safe: if parsing the value throws, return a fixed
  safe placeholder, never a best-effort partial that can leak on malformed
  input.
- Assert the secret is ABSENT — a test should check the credential or token does
  not appear in the output, not merely that "some redaction happened".
- Do not widen what is logged, persisted, or echoed to include raw request URLs,
  headers, or bodies that may carry secrets. Prefer scheme + host + path,
  redacted identifiers, or counts.
