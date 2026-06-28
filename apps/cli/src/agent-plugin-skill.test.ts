import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SETUP_MONITORS_SKILL = path.join(
  REPO_ROOT,
  'agent-plugins',
  'agentmonitors',
  'skills',
  'setup-monitors',
  'SKILL.md',
);

function skillText(): string {
  const raw = readFileSync(SETUP_MONITORS_SKILL, 'utf-8');
  // Normalize: strip a leading UTF-8 BOM (U+FEFF) and convert CRLF -> LF so
  // that Windows-saved files are handled by the same regex patterns as Unix files.
  // Mirror the normalization in apps/cli/src/commands/validate.ts.
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function frontmatterDescription(text: string): string {
  const match = /^---\n(?<frontmatter>[\s\S]*?)\n---/.exec(text);
  expect(match?.groups?.frontmatter).toBeDefined();
  const description = /^description:\s*(?<description>.+)$/m.exec(
    match?.groups?.frontmatter ?? '',
  );
  expect(description?.groups?.description).toBeDefined();
  return description?.groups?.description ?? '';
}

describe('activation plugin setup-monitors skill', () => {
  it('activates for plain-language monitor-authoring intents', () => {
    const description = frontmatterDescription(skillText());

    for (const trigger of [
      'watch this file',
      'tell me when',
      'set up a monitor',
      'notify me when',
    ]) {
      expect(description.toLowerCase()).toContain(trigger);
    }
  });

  it('requires intent-to-source selection, validation, firing verification, and explain-based debugging', () => {
    const text = skillText();

    for (const sourceType of [
      'file-fingerprint',
      'api-poll',
      'command-poll',
      'schedule',
      'incoming-changes',
    ]) {
      expect(text).toContain(sourceType);
    }

    expect(text).toContain('agentmonitors validate');
    expect(text).toContain('agentmonitors monitor test');
    // Firing verification is proven via the hook-deliver flow (session start →
    // hook deliver → events list --unread), not via `monitor history`.
    expect(text).toContain('agentmonitors session start');
    expect(text).toContain('agentmonitors hook deliver');
    expect(text).toContain('agentmonitors monitor explain');
    expect(text).toMatch(/not done until.+fired/i);
  });

  it('suggests agentmonitors init as the scaffolding starting point', () => {
    const text = skillText();
    // Agents must scaffold with `init` rather than hand-writing MONITOR.md
    // to avoid subtly-wrong frontmatter. Issue #153 (item 4).
    expect(text).toContain('agentmonitors init');
    expect(text).toMatch(/agentmonitors init .+ --type .+ --dir/);
  });

  it('verify-it-fires step uses the hook-deliver flow to prove delivery, with explain-based debugging that needs no live daemon', () => {
    const text = skillText();
    // The verify step must prove the agent is *notified*, not just that an
    // event materialised. It directs agents to register a session
    // (`session start`), trigger the condition, then claim pending deliveries
    // via `hook deliver` and confirm with `events list --unread`.
    // Issue #201 / Issue #153 (item 4) / Issue #150.
    expect(text).toContain('agentmonitors session start');
    expect(text).toContain('agentmonitors hook deliver');
    expect(text).toMatch(/events list .*--unread/);
    expect(text).toContain('agentmonitors monitor explain');
    // The debug loop's explain/events-list inspection reads persisted state, so
    // it must not imply those commands always require a live daemon.
    expect(text).toMatch(/no daemon.+persisted/i);
  });

  it('clarifies activation file is only required for session-start hook, not for daemon once', () => {
    const text = skillText();
    // The activation file gates the session-start hook only.
    // `daemon once` works without it. Issue #153 (item 4).
    expect(text).toMatch(/daemon once.+without it|without it.+daemon once/i);
  });
});
