---
'@agentmonitors/cli': patch
---

Retain incompatible heartbeat evidence for 48 hours before write-path cleanup, and show an advisory for newer heartbeat formats without changing doctor exit status. Doctor continues to leave registry files untouched.

Check an expired heartbeat's file identity before unlinking, without creating cleanup files. Device is always checked; when inode numbers are unavailable, compare ctime and birthtime as well as size and mtime using nanosecond stats. A replacement published after the final identity check can remain absent until the transport's next heartbeat write.
