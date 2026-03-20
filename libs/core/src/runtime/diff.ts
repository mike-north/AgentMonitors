import { createHash } from 'node:crypto';

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
