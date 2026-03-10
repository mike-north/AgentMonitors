import withMarkdoc from '@markdoc/next.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['md', 'mdoc', 'js', 'jsx', 'ts', 'tsx'],
};

export default withMarkdoc({ mode: 'static' })(nextConfig);
