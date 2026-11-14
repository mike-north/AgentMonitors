---
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Preserve kernel executable-path traversal and authored environment values during command admission, retain failing health and the previous baseline on exec failure, reject unrepresentable NUL bytes without truncating argv or environment values, restore native signal dispositions and masks, report ordinary exec errno without native crashes, isolate helpers from authored and inherited Node options while preserving them for the command, keep native binding lookup relative to each published module format, and release settled callers while independent watchdog deadlines remain armed.

Write admission status frames completely and reject incomplete or invalid status without replacing a successful baseline. Match platform spawn PATH search, relative executable spelling and errno precedence, including glibc's executable-format fallback. Explain platform native-support load failures with underlying detail. Ship Koffi 3.3.7 JavaScript, MIT license and macOS arm64/x64 and Linux glibc arm64/x64 prebuilds inside both packages, so CLI installation no longer requires `koffi` or `@koromix/*` from the user's registry. Load the selected binary relative to our package; unsupported platforms (including Windows and musl), missing or corrupt binaries refuse commands without plain-spawn or source-build fallback. Refresh with `node scripts/vendor-koffi.mjs`, verifying registry SHA-512 integrity and committed per-file SHA-256 hashes.

Use absolute runtime paths and start helpers with only the command-life mark in their environment, delivering the complete command environment through the configuration pipe so helper startup does not reduce the environment budget accepted by plain spawn. Keep initialization failures distinct from native-module load failures. Reparent the watchdog through a successfully reaped intermediate before exec, so commands can wait for all their own children without waiting for the watchdog. Preserve its process group, independent deadline, mark and restart accounting.

Restore blocking I/O on stdin, stdout and stderr before native execution. Clear only
`O_NONBLOCK` with the platform's variadic `fcntl` ABI, preserve unrelated status flags,
and verify each read-back. Refuse execution and retain the previous baseline if any status
operation fails or nonblocking mode survives.
