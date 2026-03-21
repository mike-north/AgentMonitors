import { execFileSync } from 'node:child_process';

const STAGED_DIFF_ARGS = [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
  '--',
  '.changeset',
];

function stagedChangesetFiles() {
  const output = execFileSync('git', STAGED_DIFF_ARGS, {
    encoding: 'utf8',
  }).trim();

  if (output.length === 0) return [];

  return output
    .split('\n')
    .map((file) => file.trim())
    .filter(
      (file) =>
        file.startsWith('.changeset/') &&
        file.endsWith('.md') &&
        !file.endsWith('/README.md'),
    );
}

function stagedFileContents(path) {
  return execFileSync('git', ['show', `:${path}`], {
    encoding: 'utf8',
  });
}

function hasMajorBump(contents) {
  const frontmatterMatch = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return false;
  return /^(?:"[^"\n]+"|'[^'\n]+'|[^:\n]+):\s*major$/m.test(
    frontmatterMatch[1],
  );
}

function main() {
  const files = stagedChangesetFiles();
  const offenders = files.filter((file) =>
    hasMajorBump(stagedFileContents(file)),
  );

  if (offenders.length === 0) return;

  console.error('Major changeset bumps are not allowed in pre-commit.');
  console.error('Update these changesets to patch or minor before committing:');
  for (const file of offenders) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

main();
