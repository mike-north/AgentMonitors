import withMarkdoc from '@markdoc/next.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['md', 'mdoc', 'js', 'jsx', 'ts', 'tsx'],

  // Pin file-tracing to THIS app's directory. It must NOT point at the monorepo
  // root (`../../`): Vercel builds apps/website standalone (root directory = the
  // app), where `../../` resolves above the deploy root and produces a doubled
  // output path (`/vercel/path0/vercel/path0/.next/...`), failing the deploy.
  outputFileTracingRoot: __dirname,

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
