import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import nextConfig from './next.config.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

describe('Next deployment config', () => {
  it('keeps output file tracing rooted at the website app directory', () => {
    // Vercel builds apps/website as the project root; tracing above this app
    // reintroduces the /vercel/path0/vercel/path0/.next deployment failure.
    expect(nextConfig.outputFileTracingRoot).toBe(appDir);
    expect(nextConfig.outputFileTracingRoot).not.toBe(repoRoot);
  });
});
