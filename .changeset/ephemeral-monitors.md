---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
'agentmonitors': minor
---

Add ephemeral (agent-declared, session-scoped) monitors — the `agentmonitors watch` verb (spec 007
§4 / 005 §14.4).

An agent can now declare a session-scoped monitor at runtime — "tell me when _X_, and remind me of
_this instruction_ when it does" — without authoring a `MONITOR.md` file:

- `agentmonitors watch <source> --session <id> --scope <spec> [--urgency] [--instruction]` declares
  one; `watch list --session <id>` and `watch cancel <ephemeralId> --session <id>` manage them.
  `--scope` accepts `key=value,...` or a JSON object.
- Ephemeral monitors flow the **same** daemon pipeline as persistent monitors (AP7):
  tick → notify → materialize → project → deliver. Their scope is validated by the **same**
  `validateScope` path as `agentmonitors validate`, so they cannot express a config a persistent
  monitor could not.
- **Projection isolation:** an ephemeral monitor's events project into the **declaring session
  only**, never a sibling lead session in the same workspace.
- **Lifecycle:** active on declaration; reaped on session close, on `watch cancel`, and on a new
  per-session dormancy trigger (a session inactive past `DEFAULT_SESSION_DORMANCY_MS`). The
  definition and its durable state survive a daemon restart while the session lives, and a reaped
  monitor is never resurrected after the session ends. Already-materialized events are retained.
- Ephemeral ids are the reserved-prefix form `ephemeral:<sessionId>/<ulid>`, structurally unable to
  collide with a directory-derived persistent monitor id.

Public core surface: `AgentMonitorRuntime` gains `declareEphemeralMonitor`, `listEphemeralMonitors`,
and `cancelEphemeralMonitor`, plus the exported `EphemeralMonitorRecord`, `EphemeralMonitorStatus`,
and `DeclareEphemeralMonitorInput` types and an optional `sessionDormancyMs` constructor option.
