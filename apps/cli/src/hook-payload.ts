/**
 * The Claude Code hook payload AgentMon reads from STDIN. Claude Code delivers
 * hook input as a JSON object on stdin (NOT environment variables); there is no
 * `CLAUDE_CODE_SESSION_ID` env var in a real hook invocation. Only the fields
 * the CLI consumes are typed; everything else is ignored.
 *
 * The same payload drives `hook deliver`, `session start`, and `session end` —
 * all three are hook-invoked and read the host session id from `session_id`.
 *
 * @see https://code.claude.com/docs/en/hooks.md (Hook Input)
 */
export interface HookPayload {
  /** Host session id; matched against tracked AgentMon sessions' hostSessionId. */
  session_id?: string;
  /** The firing event, e.g. `UserPromptSubmit` / `PostToolUse` / `SessionStart`. */
  hook_event_name?: string;
  /** Workspace path for this invocation. */
  cwd?: string;
}

/**
 * Read ALL of stdin and parse it as a Claude Code hook payload (JSON). The read
 * is **non-blocking against a missing stdin**: if stdin is a TTY (interactive /
 * no piped payload) we resolve `{}` immediately without consuming the stream, so
 * the command never hangs waiting for input that will not arrive. Any empty or
 * unparseable payload also resolves to `{}` — the caller treats a payload with
 * no `session_id` as "not a Claude session" and quietly exits 0.
 */
export async function readHookPayload(): Promise<HookPayload> {
  const stdin = process.stdin;
  // No piped input (interactive TTY) → don't wait on the stream at all.
  if (stdin.isTTY) return {};

  const raw = await new Promise<string>((resolve) => {
    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.on('end', finish);
    // If the stream errors or is otherwise unreadable, fall back to empty
    // rather than hanging or throwing.
    stdin.on('error', finish);
  });

  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return {};
    // stdin is a process trust boundary: pick ONLY the expected string fields and
    // ignore everything else. A non-string `session_id` (e.g. `123`) must NOT
    // pass through — it would be truthy yet collapse hook-state paths and risk
    // session collisions. Coercing a non-string field to absent makes the caller
    // treat it as "not a Claude session" and quietly exit.
    const record = parsed as Record<string, unknown>;
    const pickString = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === 'string' ? value : undefined;
    };
    const payload: HookPayload = {};
    const sessionId = pickString('session_id');
    if (sessionId !== undefined) payload.session_id = sessionId;
    const eventName = pickString('hook_event_name');
    if (eventName !== undefined) payload.hook_event_name = eventName;
    const cwd = pickString('cwd');
    if (cwd !== undefined) payload.cwd = cwd;
    return payload;
  } catch {
    return {};
  }
}
