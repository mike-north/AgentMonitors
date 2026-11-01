## 1. Gate parity

- [ ] 1.1 Bring `test:serial` and the standalone-consumer check (and any other CI-only suite) under the local `pnpm test` gate, or derive CI from the workspace scripts (#458)
- [ ] 1.2 Add an executable gate-parity check asserting the CI workflow's test commands are derivable from the workspace scripts

## 2. Flake hygiene

- [ ] 2.1 Fix the `verify.integration` literal-glob test that exhausts its retry budget on every run (#452)
- [ ] 2.2 Add a retry-budget assertion: the guarded suite passes with `--retry=0`
- [ ] 2.3 Harden the pr-alerting-presets real-jq subprocess handling against empty stdout (#475)
- [ ] 2.4 Fix the source-command-poll test teardown so `PATH` is restored even when a test times out (#477), with a suite-teardown guard test

## 3. Diagnosability

- [ ] 3.1 Fix the Docker runtime smoke in-container daemon startup flake and capture daemon/subprocess logs on failure (#509)
- [ ] 3.2 Add a forced-failure test per instrumented subprocess harness asserting its diagnostic dump renders
