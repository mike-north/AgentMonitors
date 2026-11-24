# Channel enqueue probe

A stdio MCP server for one manual check: does Claude Code write a
`queue-operation` / `enqueue` transcript entry for a channel push only when the
session registered a channel listener? Channel delivery commits a claim only on
that entry ([006 §4.5.2](../../../../docs/specs/006-agent-integration.md)).

The recipe, with exact commands and expected results, is
[`docs/uat/channel-transport.md`, Part C](../../../../docs/uat/channel-transport.md#part-c--host-confirmation-of-a-channel-push-006-452-issue-535).
The probe is not used by any automated test.
