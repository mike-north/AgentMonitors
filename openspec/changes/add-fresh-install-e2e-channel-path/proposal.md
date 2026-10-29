## Why

The fresh-environment E2E proves install-to-first-signal only for the hooks delivery path. The
MCP/channel transport has no equivalent proof from a global install with no workspace
`node_modules`, so a packaging or wiring defect specific to the channel path would ship undetected.
004 §2.7 tracks this as a follow-up outside the hooks surface's scope.

Source: 004 §2.7 ("The MCP/channel transport … has no equivalent fresh-environment proof yet — tracked
as a follow-up"). Builds on the hooks-path surface from #276. No GitHub issue is filed for the channel
follow-up yet.

## What Changes

- Add a fresh-environment E2E for the channel delivery transport: global install of the packed
  `agentmonitors` launcher into an isolated npm prefix, project bootstrap via `agentmonitors init`, a
  `file-fingerprint` monitor firing, and the signal reaching a channel client over the real channel
  transport contract (per `delivery/channel-transport`).
- Run it in CI on every PR alongside the hooks-path E2E.

Principles: relies on PP4 (delivery is session-aware) and AP1 (runtime/session pipeline is
authoritative). Does not resolve a spec/code contradiction; it closes a proof gap.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering/test-integrity`: adds a channel-path fresh-install E2E obligation.

## Impact

- New script under `scripts/` and a `package.json` script entry; `.github/workflows/ci.yml` step.
- No published package behavior changes, so no changeset or website update is expected unless the
  E2E surfaces a defect.
