/** Test-only command/reader lifecycle shared by preset observations and FIFO probes. */
/** POSIX shell program; the source still owns process-group deadlines. @internal */
export const PRESET_CAPTURE_COMMAND = `fifo="$AM475_STDERR.pipe"
mkfifo "$fifo" || exit 125
# Drain to completion while retaining a bounded tail before the parent reads it.
"$AM475_NODE" "$AM475_READER" "$AM475_STDERR" "$AM475_TOTAL" <"$fifo" &
reader=$!
# Record all initial group members, including the watchdog, before fixture work.
if [ -n "\${AM475_OWNED_GROUP_FILE:-}" ]; then
  "$AM475_NODE" "$AM475_OWNED_SIGNAL" record "$AM475_OWNED_GROUP_FILE" "$$" || exit 125
fi
trap 'if [ -n "$reader" ]; then kill "$reader" 2>/dev/null || :; fi; rm -f "$fifo"' EXIT
# Keep the FIFO writer descriptor out of the waiting parent shell. Some POSIX
# shells retain a foreground command's redirection until that command exits;
# the exec subshell makes writer EOF independent of command/process lifetime.
(exec "$@" 2>"$fifo")
code=$?
if wait "$reader"; then reader=""; else reader=""; exit 125; fi
printf "%s" "$code" >"$AM475_EXIT"
exit "$code"`;
