---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Make delivered monitor text self-sufficient, and let each transport own its own attribution.

The coalesced `normal`/`low` reminder used to read `AgentMon messages are available. Read the inbox.`
— which named a product on a surface that already identified it, pointed at the non-authoritative
legacy `inbox` model, and told the recipient nothing they could actually run. The runtime's own
message is now just the transport/verb-neutral semantic sentence:

```
Monitored changes are pending.
```

Each transport appends its own concrete, session- (and where applicable socket-) scoped action step:
the hook transport appends `agentmonitors events list --session <id> --unread` / `agentmonitors
events ack --session <id>`, and the channel transport points at listing the unread events followed
by its `agentmon_ack` tool.

- **Attribution is transport-owned.** The runtime emits an unattributed, semantic message; the
  hook transport prepends `AgentMon: ` (its injected context arrives unlabeled), and the channel
  transport prepends nothing (its `<channel source="agentmonitors">` tag already names the source,
  so the old prefix double-attributed every push). Adding a new delivery surface now means choosing
  its attribution in that transport, not editing the runtime.
- **Deliveries that inject event bodies now say how to finish.** A high-urgency delivery and the
  `SessionStart` recap each carry a single per-batch line naming the acknowledge command for that
  session. Because claiming is not acknowledging, a session that handled its delivery but never
  acknowledged previously had that same band's own later reminder silently suppressed by the
  band-scoped coalesced-until-ack rule (an unacknowledged claim never suppresses a different,
  unrelated urgency band's reminder), with the remediation visible only in `monitor explain`.
- **Acknowledging a whole session no longer risks a row an in-flight channel push is still
  mid-surfacing.** `AgentMonitorRuntime.acknowledgeSession(sessionId)` (no explicit `eventIds`) now
  excludes rows currently leased by an outstanding delivery reservation (issue #300). The reminder-
  suppression diagnosis (`monitor explain`, `hook deliver --debug`) also gains a `reserved-in-flight`
  `HookDeliveryHoldReason`/`ReminderSuppressionReason` for this case, so a live lease is never
  reported (or explained) as something `events ack` can or should clear.
- No change to notify/debounce timing, urgency bands, coalescing behavior, or the
  unread/claimed/acknowledged model. The legacy `inbox` CLI surface is untouched.

See docs/specs/002-runtime-delivery.md §9.2 and docs/specs/006-agent-integration.md §5.1.1.
