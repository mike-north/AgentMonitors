import { createHash } from 'node:crypto';
import {
  computeDerivedFacts,
  renderArtifact,
  type DerivedFactRule,
} from './shape.js';

export function fingerprintText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildTextDiff(previous: string, current: string): string {
  if (previous === current) return '';

  const prevLines = previous.split('\n');
  const currLines = current.split('\n');
  const max = Math.max(prevLines.length, currLines.length);
  const chunks: string[] = [];

  for (let i = 0; i < max; i++) {
    const before = prevLines[i];
    const after = currLines[i];
    if (before === after) continue;
    const line = i + 1;
    if (before !== undefined) chunks.push(`- ${String(line)}: ${before}`);
    if (after !== undefined) chunks.push(`+ ${String(line)}: ${after}`);
    if (chunks.length >= 20) break;
  }

  return chunks.join('\n');
}

/**
 * Render a shaped snapshot to the stable Shape artifact (§1.1.5), the input the
 * runtime diffs **instead of** the raw source. Deterministic and pure over
 * `(snapshot, now, rules)`: the only time input is the injected `now`. Computes
 * the derived facts (§1.1.4), then renders the shaped state to a byte-stable
 * artifact. The same shaped state at the same `now` MUST render to byte-identical
 * text (no phantom diff).
 *
 * @param snapshot - The shaped snapshot (the source's raw facts).
 * @param now - The runtime-injected tick clock, in epoch milliseconds.
 * @param rules - The author-declared `shape.derive` rules, in order.
 * @returns The byte-stable rendered artifact.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4–§1.1.5
 */
export function renderShapeArtifact(
  snapshot: unknown,
  now: number,
  rules: readonly DerivedFactRule[],
): string {
  const facts = computeDerivedFacts(snapshot, now, rules);
  return renderArtifact(snapshot, facts);
}
