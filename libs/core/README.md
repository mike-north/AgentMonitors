# @agentmonitors/core

Host-agnostic engine for [Agent Monitors](https://agentmonitors.io): monitor parsing, the runtime
tick loop, the observation-source registry, persistence, notify policy, and delivery projection.
Host adapters (e.g. Claude Code) and the bundled `plugins/source-*` observation sources are built
on top of this package.

Most users don't depend on this package directly — install the
[`agentmonitors`](https://www.npmjs.com/package/agentmonitors) CLI instead. `@agentmonitors/core`
is for building new host adapters or observation sources.

## Requirements

Node.js `>=24`.

## Documentation

- [agentmonitors.io](https://agentmonitors.io) — user docs
- [`docs/specs/`](https://github.com/mike-north/AgentMonitors/tree/main/docs/specs) — the canonical
  specification for this package's contracts (parsing, runtime, source-plugin interface)

## License

MIT © Mike North
