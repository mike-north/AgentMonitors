import withMarkdoc from '@markdoc/next.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['md', 'mdoc', 'js', 'jsx', 'ts', 'tsx'],

  // Suppress workspace-root detection warning caused by multiple pnpm lockfiles
  // in the monorepo worktree setup.
  outputFileTracingRoot: path.join(__dirname, '../../'),

  // Rewrite <path>.md → the raw markdown API route so LLMs and curl
  // can fetch the plain .md source of any page.
  async rewrites() {
    return [
      {
        source: '/:path*.md',
        destination: '/api/raw/:path*',
      },
    ];
  },
};

export default withMarkdoc({ mode: 'static' })(nextConfig);
