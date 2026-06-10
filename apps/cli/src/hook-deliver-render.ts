import type { DeliveryClaim } from '@agentmonitors/core';

const MAX_ADDITIONAL_CONTEXT = 4000;

/**
 * `additionalContext` is a plain JSON string — `JSON.stringify` escapes quotes,
 * backslashes, and control characters when the command serializes the output, so
 * no character is a "JSON injection" vector here. Unlike the channel transport
 * (which embeds text in `<channel>` tag attributes — see channel-render.ts), this
 * field is NOT tag-delimited, so `<`, `>`, `[`, `]`, `;` are inert and must be
 * preserved: a monitor body is trusted, user-authored markdown that routinely
 * contains code (`Array<T>`), links (`[text](url)`), and punctuation, and its
 * multi-line structure carries meaning. We therefore strip only raw C0/C1 control
 * characters (except tab and newline) that could corrupt terminal/log output, and
 * preserve everything else faithfully. Length is capped by the caller.
 */
function sanitize(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl =
      (code < 0x20 && ch !== '\n' && ch !== '\t') ||
      (code >= 0x7f && code <= 0x9f);
    if (!isControl) out += ch;
  }
  return out.trim();
}

/**
 * The exact wire shape a Claude Code hook must print to stdout to inject
 * advisory context at a turn boundary. `continue: true` makes it non-blocking;
 * `hookSpecificOutput` carries the event name and the context text.
 *
 * Advisory delivery MUST NOT include a `permissionDecision` field — the agent
 * decides how to handle the surfaced context (BP2).
 *
 * @see https://docs.claude.ai/en/api/claude-code/hooks
 */
export interface HookDeliveryOutput {
  continue: true;
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * Render a {@link DeliveryClaim} into the advisory hook-output payload that a
 * turn-boundary hook prints to stdout. Returns `null` when there is nothing to
 * inject (null claim or zero events), so the caller can skip stdout entirely.
 *
 * The renderer is **pure and side-effect-free**: no I/O, no mutation. Text is
 * preserved faithfully (a monitor body is trusted, user-authored markdown) with
 * only raw control characters removed (see {@link sanitize}); the total
 * `additionalContext` is capped so a large diff cannot blow the context window.
 *
 * @param claim - The delivery claim from `claimDeliveryClient`, or null.
 * @param hookEventName - The Claude Code event name to echo (e.g. `"PreToolUse"`).
 */
export function renderHookDelivery(
  claim: DeliveryClaim | null,
  hookEventName: string,
): HookDeliveryOutput | null {
  if (!claim || claim.events.length === 0) return null;

  const leadLine =
    'AgentMon: monitored changes are pending — consider handling them before continuing.';

  const blocks = claim.events.map((e) => {
    const id = sanitize(e.monitorId);
    const urgency = sanitize(e.urgency);
    const title = sanitize(e.title);
    const body = sanitize(e.body);
    return `### ${id} (${urgency})\n${title}\n\n${body}`;
  });

  const full = [leadLine, '', ...blocks].join('\n');
  const additionalContext = full.slice(0, MAX_ADDITIONAL_CONTEXT);

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}
