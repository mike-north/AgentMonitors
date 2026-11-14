---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Reap orphaned command processes on macOS after a daemon restart using kernel environment evidence, with the same boot, ownership and process identity checks as Linux. Argument text never proves ownership. Batch discovery and signal verification through one asynchronous stock `/usr/bin/osascript -l JavaScript` helper per sweep, and batch terminal checks and durable receipt writes to keep startup bounded. No Homebrew tools or native addons are required.

Use Foundation-owned buffers to call sysctl without developer tools. Record conservative abstentions with reasons when the helper is unavailable or a process environment cannot be read. Treat empty or padded argv entries, process-title rewrites and an unproven envp boundary as per-PID unreadability rather than silently reporting the process unmarked.

Never skip NULs after the executable path as presumed alignment: they could be an empty first argument. Bound each parse to sysctl's returned byte count so shorter replies cannot inherit ownership evidence from a previous PID's buffer.
