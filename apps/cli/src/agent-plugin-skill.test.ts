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
  return readFileSync(SETUP_MONITORS_SKILL, 'utf-8');
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
});
