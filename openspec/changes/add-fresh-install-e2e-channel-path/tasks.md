## 1. E2E script

- [ ] 1.1 Add a channel-path fresh-install E2E script under `scripts/` that reuses the hooks-path pack/install/init flow from `scripts/test-e2e-fresh-install-hooks.mjs`
- [ ] 1.2 Connect a channel client for a session through the launcher's installed entry point and assert the monitor's signal arrives over the channel transport, forcing a tick via the daemon socket rather than sleeping
- [ ] 1.3 Add a `package.json` script entry for the new E2E

## 2. CI

- [ ] 2.1 Wire the new E2E into `.github/workflows/ci.yml` per-PR, next to the hooks-path E2E step

## 3. Verification

- [ ] 3.1 Confirm the E2E fails when the channel transport is broken (e.g. by temporarily disabling channel delivery) so it cannot pass vacuously
