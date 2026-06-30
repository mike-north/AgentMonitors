# agentmonitors

Short-name installer for the [Agent Monitors](https://agentmonitors.io) CLI.

This package re-exports the `agentmonitors` binary from [`@agentmonitors/cli`](https://www.npmjs.com/package/@agentmonitors/cli) under the unscoped name so that the standard global install command works:

```sh
npm i -g agentmonitors
agentmonitors --help
```

All functionality lives in `@agentmonitors/cli`. See the [Agent Monitors documentation](https://agentmonitors.io) for usage.
