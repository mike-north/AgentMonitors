/**
 * Spec history is authored as one Markdown file per change, never as a shared append target.
 * Each file starts with `## YYYY-MM-DD — <full title>`; issue and section references are
 * retained in that title only when supplied by the author. The remaining bytes are the body.
 * Assembly sorts dates newest first, then filenames in ascending code-unit order. Migrated
 * names carry their original ordinal, preserving same-date order without a shared counter
 * for future contributions. Output goes only to stdout; the tracked index is never rewritten.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Reject old-branch insertions before reading entries, so they cannot disappear from history. */
function readEntries(root) {
  const specs = path.join(root, 'docs/specs');
  if (
    /^## \d{4}-\d{2}-\d{2}/m.test(
      readFileSync(path.join(specs, 'spec-changelog.md'), 'utf8'),
    )
  ) {
    throw new Error(
      'spec-changelog.md: dated headings belong in changelog/ entry files',
    );
  }
  const directory = path.join(specs, 'changelog');
  const identities = new Set();
  return readdirSync(directory)
    .sort()
    .map((name) => {
      if (!name.endsWith('.md')) {
        throw new Error(`${name}: entry files must use .md`);
      }
      const text = readFileSync(path.join(directory, name), 'utf8');
      const heading = text.split('\n')[0];
      const date = /^## (\d{4}-\d{2}-\d{2})(?: |$)/u.exec(heading)?.[1];
      if (
        !date ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      ) {
        throw new Error(`${name}: expected a valid YYYY-MM-DD date`);
      }
      const title = /^## \d{4}-\d{2}-\d{2} — (.*)$/u.exec(heading)?.[1];
      if (!title?.trim()) {
        throw new Error(
          `${name}: expected a nonempty title after the date and em dash`,
        );
      }
      if (/^## /m.test(text.slice(heading.length + 1))) {
        throw new Error(
          `${name}: only one second-level entry heading is allowed`,
        );
      }
      const identity = `${date}\n${title.trim()}`;
      if (identities.has(identity)) {
        throw new Error(`${name}: duplicate date and title`);
      }
      identities.add(identity);
      // A line boundary is required so the next file's heading cannot join a body line.
      if (!text.endsWith('\n')) {
        throw new Error(`${name}: entry must end with a newline`);
      }
      return { date, text };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Both modes validate the complete input; assembly cannot silently omit an invalid entry. */
function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--check', '--assemble'].includes(mode)) {
    throw new Error(
      'Usage: node scripts/spec-changelog.mjs --check|--assemble',
    );
  }
  const entries = readEntries(process.cwd());
  if (mode === '--assemble') {
    process.stdout.write(
      '# Spec Changelog\n\n' + entries.map((entry) => entry.text).join(''),
    );
  } else {
    console.log(`Spec changelog: ${entries.length} valid entries`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
