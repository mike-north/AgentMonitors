# Codex live host probe

The [artifact](../../experiments/host-probe/results/codex-cli-0.172.0.json) and its linked
sightings record observations from Codex CLI 0.172.0 on macOS. This is host evidence, not a
production delivery implementation. The disposable sessions used `gpt-6.1-terra`.

All eight requested hooks fired in the isolated plain TUI, including both compaction hooks after
`/compact` and SessionEnd on exit. Their stdin field names are in the artifact. SessionStart and
UserPromptSubmit delivered both context and plain-output markers; PreToolUse and PostToolUse
delivered context markers but the model did not echo their plain-output markers. Stop, PreCompact,
PostCompact and SessionEnd received valid common JSON instead of unsupported event-specific
context; the Stop and compaction system messages were visible in the TUI but were not echoed by
the model after compaction. This does not establish delivery of an `additionalContext` or plain
stdout nonce for those events. Each sighting now identifies the actual output shape. In the
earlier attempt, the TUI reported `hook returned invalid stop hook JSON output`, `hook returned
invalid PreCompact hook JSON output`, and `hook returned invalid PostCompact hook JSON output`.
The display did not identify the handler responsible; SessionEnd rejection was not observable
after exit. Those errors do not establish delivery behavior.

The isolated hook session ID and its rollout `session_meta.id` have the same hash. That is not a
default-control-socket identity comparison. A plain TUI with the ordinary home did not appear in
the default socket's loaded list, even though a managed daemon with `tui_multi_backend` was
running. The full redacted invocation and environment limits are in the artifact. A TUI explicitly
connected to the socket did appear, but its hook overrides were not observed. The default-socket
same-session comparison remains unestablished. A desktop session was not identified; a `vscode`
source alone is insufficient. To complete that check, open a new desktop chat in a unique empty
`<tmp-workspace>`, send a short prompt, and leave it open for a read-only loaded-list and
`thread/read` workspace comparison.

On a newly created idle thread, an unsteered `turn/start` completed with 32,468 total tokens
(32,462 input, including 30,848 cached, and 6 output). On a separate newly created thread, the turn
with steering used 97,532 total tokens; this is combined usage, not a standalone wake measurement.
Active-turn `turn/steer` returned success and its nonce appeared in the answer. Idle
`thread/inject_items` returned `{}`, no turn started during the 1.5-second observation, and its
nonce appeared in the next answer. The earlier turn's 97,547 total tokens likewise include steering.
The artifact retains allowlisted request and response envelopes, lifecycle notifications, and usage;
model output is reduced to marker-presence receipts. The Unix socket required WebSocket framing;
the proxy forwards a raw stream and did not translate newline JSON into that framing.

Against the November 24 survey, the hook lifecycle observations support the listed events, and the
steer and inject results support the expected delivery behaviors within this run's bounds. The
PreToolUse context echo is an additional observed context surface. The ordinary TUI's absence from
the default loaded list limits the expected shared-daemon route; it does not establish that every
TUI is unreachable. Desktop and IDE reachability remain unestablished, not confirmed absent.

The generated experimental schemas are pinned to the installed version. The standalone suite is
the validation surface for this experiment; it does not establish desktop or production behavior.
For a repeat delivery experiment, run `node codex-delivery.mjs SOCKET WORKSPACE OUTPUT` from the
host-probe directory with an absolute Unix socket and empty disposable `<tmp-workspace>`. The command
creates its own thread, restricts delivery calls to its own created IDs, and writes redacted
receipts. It consumes model usage. Hook recording uses `node codex-live.mjs OUTPUT MODE NONCE` as
the command for each event and output mode; its output is best-effort and its sightings retain
field names and hashed identities, not stdin values.
