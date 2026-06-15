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
    expect(text).toContain('agentmonitors monitor history');
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

  it('verify-it-fires step uses daemon once + history/explain without requiring a live daemon', () => {
    const text = skillText();
    // The verify step must direct agents to run `daemon once` for a tick,
    // then use `monitor history` / `monitor explain` to confirm firing.
    // Both commands now read persisted state in-process (no daemon required).
    // Issue #153 (item 4) / Issue #150.
    expect(text).toContain('daemon once');
    expect(text).toMatch(/monitor history.+\n.+monitor explain/ms);
    // Must not imply that history/explain always require a live daemon
    expect(text).toMatch(/no daemon.+persisted/i);
  });

  it('clarifies activation file is only required for session-start hook, not for daemon once', () => {
    const text = skillText();
    // The activation file gates the session-start hook only.
    // `daemon once` works without it. Issue #153 (item 4).
    expect(text).toMatch(/daemon once.+without it|without it.+daemon once/i);
  });
});
