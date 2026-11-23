/**
 * Facility control: execute the shipped preset jq programs directly. No shell,
 * gh stub, or command-poll observation is started here. Real source integration
 * remains in the unchanged CLI package preset suite, run by pnpm test/verify.
 */
import { jqAvailable, runJqCommand } from './run-jq-command.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMonitor } from '../libs/core/src/parser/parse-monitor.js';
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../apps/cli/src/commands/init.js';

const hasJq = await jqAvailable();

describe('direct shipped jq reductions', () => {
  if (!hasJq) {
    (process.env.CI ? it : it.skip)(
      'jq reductions omitted: install jq for real preset programs',
      () => {
        throw new Error(
          'jq was not found on PATH; CI requires real shipped reductions',
        );
      },
    );
    return;
  }

  it.each(['pr-review', 'my-prs'] as const)(
    'executes the actual %s program on authored fixtures',
    async (preset) => {
      const parsed = parseMonitor(
        TEMPLATES[preset],
        join(tmpdir(), preset, 'MONITOR.md'),
      );
      if (!parsed.ok) throw new Error(`Shipped ${preset} did not parse`);
      const command = parsed.monitor.frontmatter.watch.command;
      if (!Array.isArray(command) || typeof command[2] !== 'string')
        throw new Error('Unrecognized shipped preset command');
      const script = command[2];
      // Pin the supported scaffold boundary, never substitute a copied filter.
      const programs = [
        ...script.matchAll(/\| jq -sc (?:--arg scope "\$search" )?'([^']+)'/g),
      ];
      expect(programs).toHaveLength(1);
      const program = programs[0]?.[1];
      if (!program) throw new Error('Missing shipped jq program');
      const args = ['-sc'];
      let input: string;
      let expected: unknown;
      if (preset === 'pr-review') {
        const scope = /^search='([^']+)'/m.exec(script)?.[1];
        if (!scope) throw new Error('Missing shipped review scope');
        args.push('--arg', 'scope', scope);
        const pr = {
          number: 7,
          headRefName: 'fix/owned',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          author: { login: 'contributor' },
          statusCheckRollup: [],
        };
        input = `${JSON.stringify({ login: 'octocat' })}\n${JSON.stringify([pr, { ...pr, number: 8, isDraft: true }, { ...pr, number: 9, author: { login: 'octocat' } }])}\n`;
        expected = [
          { number: 7, headRefName: 'fix/owned', author: 'contributor' },
        ];
      } else {
        const pr = {
          number: 11,
          url: 'https://example.test/pr/11',
          state: 'OPEN',
          isDraft: false,
          author: { login: 'octocat' },
          statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
          latestReviews: [],
          comments: [],
        };
        input = `${JSON.stringify([pr, { ...pr, number: 12, statusCheckRollup: [] }])}\n[]\n[]\n`;
        expected = [
          {
            number: 11,
            url: 'https://example.test/pr/11',
            needs: 'ci-failing',
            failingChecks: ['build'],
            reviews: [],
            commentCount: 0,
          },
        ];
      }
      const result = await runJqCommand([...args, program], input);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    },
  );
});
