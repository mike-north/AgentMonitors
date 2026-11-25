## 2026-07-19 — Delivered text is self-sufficient, and attribution is transport-owned (002 §9.2/§9.3, 005 §12, 006 §5.1.1) — Refs #438, #434

Two defects observed in the same dogfood session, both in what a recipient actually reads.

**1. The coalesced reminder was vague, legacy-flavored, and double-attributed (#438).** The normal/low
reminder body was a fixed string, `'AgentMon messages are available. Read the inbox.'`, carrying three
problems at once: it embedded a product name, which the channel surface then repeated (its
`<channel source="agentmonitors">` tag already names the source); it pointed at the legacy `inbox`
model, explicitly non-authoritative per 002 §12, so the instruction had no runnable referent; and it
was not actionable — neither an agent nor a human could tell what to run.

Resolved by splitting the concern along the transport seam. The runtime now emits an **unattributed,
transport/verb-neutral, semantic** message built by `reminderMessage()` — just "Monitored changes are
pending." — with no CLI commands and no session id embedded. Each transport supplies its own concrete
action step, scoped with the session id (and, where applicable, the resolved socket path) it already
has on hand: the hook transport appends `agentmonitors events list --session <id> --unread` /
`agentmonitors events ack --session <id>` commands, the channel transport points at its `agentmon_ack`
tool. **Attribution became transport-owned:** the hook transport prepends `AgentMon: ` (its
`additionalContext` arrives unlabeled), the channel prepends nothing. 002 §9.2 states the wording
contract normatively (no product name, no `inbox` reference, self-sufficient down to the ack step);
§9.3 now shares it, so the low band no longer has separate prose. The legacy `inbox` CLI surface is
untouched.

**2. Nothing in a delivered payload said how to acknowledge (#434).** A body-injection delivery claims
the events it renders, and claiming is not acknowledging — so under the coalesced-until-ack rule
(002 §9.2), a session that handled its delivery fully but never acked had every subsequent
normal-urgency reminder suppressed. Observed live: a monitor fired 5 more times over ~90 minutes with
the session never re-notified. The remediation existed only in `monitor explain`, which nobody runs
while things appear fine — the delivery-side twin of #425's silent-drop family.

Resolved by adding a one-line acknowledge instruction to the hook transport's body-injection header
(006 §5.1.1), emitted **once per delivery batch** and kept terse for the 4000-char injection budget;
it covers both the `turn-interruptible` high-urgency delivery and the `SessionStart` (`post-compact`)
recap. Reminder-only deliveries do not repeat it — their ack step is already in the runtime's semantic
message. The channel does not render it either: a channel agent acks via the `agentmon_ack` tool.

**Deliberately deferred, with rationale recorded in 006 §10:** (a) auto-acknowledging events claimed
by a previous delivery when a newer one is surfaced (#434's "consider, don't necessarily build") — it
would collapse the unread/claimed/acknowledged distinction into "a later delivery happened" and
discard exactly the signal #425's transport-health surface needs, so it is a deliberate model change
to decide alongside #435, not a renderer detail; (b) #438's channel-native `agentmon_inbox` tool and
the `/agentmonitors:inbox` slash command — both enabled by this seam, both host-specific surface area
beyond the delivered-text contract.

