---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Reap orphaned command processes on macOS after a daemon restart using kernel environment evidence, with the same boot, ownership and process identity checks as Linux. Argument text never proves ownership. Batch discovery and signal verification through one asynchronous system Python helper per sweep, and batch terminal checks and durable receipt writes to keep startup bounded. No Homebrew tools or native addons are required.

Check for Command Line Tools or Xcode before invoking the system Python shim so a background restart cannot open an installation dialog. Record conservative abstentions with reasons when the interpreter is unavailable or a process environment cannot be read.
