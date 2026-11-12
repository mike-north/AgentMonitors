/** Every shipped cleanup caller is documented, and raw signals remain confined to the shared gate. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const GATE = 'libs/core/src/process/process-identity.ts';

/** Fixtures and tests may deliberately kill owned processes; this inventory covers shipped behavior. */
function shippedFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (
        ['node_modules', 'dist', 'temp', 'fixtures', 'test-fixtures'].includes(
          entry.name,
        )
      )
        return [];
      return shippedFiles(file);
    }
    return /\.ts$/.test(file) && !/\.(test|test-support)\.ts$/.test(file)
      ? [file]
      : [];
  });
}

it('routes every shipped raw cleanup signal through the gate and inventories its callers', () => {
  const spec = readFileSync(
    path.join(ROOT, 'docs/specs/008-reliability-process-hygiene.md'),
    'utf8',
  );
  const inventory = spec.slice(spec.indexOf('### 5.2'), spec.indexOf('## 6.'));
  const violations: string[] = [];
  const callers = new Set<string>();
  for (const file of ['libs', 'apps/cli/src', 'plugins'].flatMap(
    shippedFiles,
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(ROOT, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'sendVerifiedSignal'
        ) {
          callers.add(file);
          if (!inventory.includes(file))
            violations.push(`Undocumented verified-signal caller: ${file}`);
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'kill'
        ) {
          const signal = node.arguments[1];
          const liveness =
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'process' &&
            signal !== undefined &&
            ts.isNumericLiteral(signal) &&
            signal.text === '0';
          if (!liveness && file !== GATE)
            violations.push(`Raw cleanup signal outside gate: ${file}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(callers).toContain('libs/core/src/process/command-process-journal.ts');
  expect(inventory).toContain('`CommandProcessJournal.sweep`');
  expect(violations).toEqual([]);
});
