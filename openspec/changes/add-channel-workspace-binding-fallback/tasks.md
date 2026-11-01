## 1. Decide the session-ownership question

- [ ] 1.1 Decide whether a channel used without the hook-driven `session open` flow opens a synthetic workspace-lead session or requires the hook flow (design.md open question); record the decision in the channel-transport spec

## 2. Workspace-binding fallback

- [ ] 2.1 In `channel serve`, when no host session id is available, resolve the workspace from `CLAUDE_PROJECT_DIR`, falling back to MCP `roots/list`
- [ ] 2.2 Add daemon IPC to list the active lead sessions projected for a workspace and to read a workspace's unread without claiming (per `daemon/ipc`)
- [ ] 2.3 With one active lead, run the existing reserve → push → commit/release cycle against that lead
- [ ] 2.4 With multiple active leads, push an unread summary without reserving or claiming
- [ ] 2.5 Keep session binding preferred whenever `CLAUDE_CODE_SESSION_ID` or `--host-session-id` is present

## 3. Tests

- [ ] 3.1 Integration test: workspace-bound channel with one lead claims and commits exactly that lead's settled `high` event
- [ ] 3.2 Integration test: workspace-bound channel with two leads claims nothing; each lead's `hook deliver` still surfaces its own event
- [ ] 3.3 Integration test: both env vars set → binding is by session id
- [ ] 3.4 Unit test: workspace resolution order (`CLAUDE_PROJECT_DIR`, then `roots/list`)

## 4. Release and docs

- [ ] 4.1 Add a changeset for `@agentmonitors/cli`
- [ ] 4.2 Update the channel transport page in `apps/website`
- [ ] 4.3 Run the channel UAT recipe (`docs/uat/channel-transport.md`) without `CLAUDE_CODE_SESSION_ID` and record the run
