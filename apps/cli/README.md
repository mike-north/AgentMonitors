# @agentmonitors/cli

The `agentmonitors` command-line interface: validate and scan monitors, run the daemon, query
events and the legacy inbox, and deliver signals into Claude Code sessions via hooks/MCP.

Most users should install the short, unscoped
[`agentmonitors`](https://www.npmjs.com/package/agentmonitors) package instead — it's a thin
launcher for this one:

```sh
npm install -g agentmonitors
agentmonitors --help
```

## Requirements

Node.js `>=24`.

## Documentation

- [agentmonitors.io](https://agentmonitors.io) — getting started, authoring monitors, end-to-end
  delivery
- [CLI reference](https://agentmonitors.io/docs) /
  [`docs/specs/005-cli-reference.md`](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/005-cli-reference.md)

## License

MIT © Mike North
