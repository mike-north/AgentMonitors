import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Serves raw Markdown source for any doc page.
 *
 * A Next.js rewrite maps  GET /any/path.md  →  /api/raw/any/path
 * This handler reads the corresponding .md file from src/pages/ and returns
 * it with Content-Type: text/markdown so LLMs and curl get plain source.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const segments = req.query['path'];
  if (!segments) {
    res.status(400).end('Bad request');
    return;
  }

  const parts = Array.isArray(segments) ? segments : [segments];

  // Security: reject any traversal attempts before path.join resolves them
  if (parts.some((p) => p.includes('..') || p.includes('\0'))) {
    res.status(400).end('Bad request');
    return;
  }

  const pagesDir = path.join(process.cwd(), 'src', 'pages');
  const filePath = path.join(pagesDir, ...parts) + '.md';

  // Ensure the resolved path stays inside pagesDir
  if (!filePath.startsWith(path.resolve(pagesDir) + path.sep)) {
    res.status(403).end('Forbidden');
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).end('Not found');
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  // Allow CDN/browser caching for 60 s, stale-while-revalidate for 5 min
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).end(content);
}
