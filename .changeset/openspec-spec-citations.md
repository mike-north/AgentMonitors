---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Spec references in user-facing text now name the OpenSpec capability that owns the behavior (for example `spec: delivery/lifecycles`) instead of the retired numbered-spec sections (`002 §9.2`). This affects the comments `agentmonitors init` writes into the PR-alerting preset monitors, the error messages for rejected ephemeral watch declarations, and TSDoc comments in `@agentmonitors/core`'s published type declarations. Only the reference text changed; behavior is unchanged.
