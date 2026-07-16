import { describe, expect, it } from 'vitest';
import { parseMonitor } from '@agentmonitors/core';
import { TEMPLATES } from './init.js';
import { COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND } from './scaffold-defaults.js';

// Direct drift-guard test for the claim in scaffold-defaults.ts's doc
// comment: "the template's `command:` block still equals this array". Parses
// the actual `init --type command-poll` template (not a copy) and asserts
// its watch.command deep-equals COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND, so the
// two literals can't silently diverge.
describe('COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND drift guard', () => {
  it("equals the command-poll template's untouched command: block", () => {
    const template = TEMPLATES['command-poll'];
    expect(template).toBeDefined();
    const parsed = parseMonitor(
      template ?? '',
      '/tmp/command-poll-template/MONITOR.md',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const watch = parsed.monitor.frontmatter.watch as Record<string, unknown>;
    expect(watch['command']).toEqual(COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND);
  });
});
