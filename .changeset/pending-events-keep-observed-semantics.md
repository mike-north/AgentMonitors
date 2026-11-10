---
'@agentmonitors/core': patch
---

Editing a monitor no longer leaves any doubt about already-pending events: they are delivered with
the urgency, title and body they were observed under, and this is now covered by tests and stated in
the delivery spec. `monitor explain` also reports how many pending events predate the monitor's
current definition (urgency or body changed since they were observed).
