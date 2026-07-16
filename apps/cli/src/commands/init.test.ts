import { describe, expect, it } from 'vitest';
import { seedCommand, TEMPLATES } from './init.js';

// Issue #388 review follow-up: seedCommand's block-replacement previously
// used a bare `String.replace(blockPattern, ...)` with no check that
// `blockPattern` actually matched. If the command-poll template's `command:`
// block ever drifted out of that exact shape, `--command` would be silently
// ignored — the scaffold would ship the untouched `ls-remote` default while
// looking like the user's seed had applied. This is the wrong-intent trap
// issue #388 exists to prevent, just reintroduced one layer down.
describe('seedCommand drift guard', () => {
  it('throws InitSeedError instead of silently ignoring --command when the command-poll template has drifted out of the expected command: block shape', () => {
    // Deliberately non-matching shape: `command:` is a flow scalar here, not
    // a `- token` list, so seedCommand's blockPattern cannot match it. A
    // correct template never looks like this — this string exists solely to
    // simulate template drift.
    const driftedTemplate = [
      '---',
      'name: Upstream branch monitor',
      'watch:',
      '  type: command-poll',
      '  command: git ls-remote origin refs/heads/main',
      '  interval: 5m',
      'urgency: normal',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n');

    expect(() =>
      seedCommand(driftedTemplate, 'command-poll', ['echo', 'hi']),
    ).toThrow(/Could not find a command: argv block/);
  });

  it('still seeds correctly against the real, undrifted command-poll template (control case)', () => {
    const template = TEMPLATES['command-poll'];
    expect(template).toBeDefined();
    const seeded = seedCommand(template ?? '', 'command-poll', ['echo', 'hi']);
    expect(seeded).toContain("  command:\n    - 'echo'\n    - 'hi'\n");
  });
});
