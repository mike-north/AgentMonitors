# @agentmonitors/source-command-poll

Local-command polling and change detection for [Agent Monitors](https://agentmonitors.io). One of
the observation sources bundled with Agent Monitors — select it in a `MONITOR.md`'s `watch.type`
field, or scaffold one with:

```sh
agentmonitors init <name> --type command-poll
```

Most users don't depend on this package directly; it installs automatically as a dependency of
[`@agentmonitors/cli`](https://www.npmjs.com/package/@agentmonitors/cli) /
[`agentmonitors`](https://www.npmjs.com/package/agentmonitors). It's published separately so custom
host adapters can register it directly against `@agentmonitors/core`'s `SourceRegistry`.

## Requirements

Node.js `>=24`.

## Documentation

- [Authoring monitors](https://agentmonitors.io/docs/authoring-monitors)
- [`sources/contract`](https://github.com/mike-north/AgentMonitors/blob/main/openspec/specs/sources/contract/spec.md) and [`sources/command-poll`](https://github.com/mike-north/AgentMonitors/blob/main/openspec/specs/sources/command-poll/spec.md)

## License

MIT © Mike North
