import { Head, Html, Main, NextScript } from 'next/document';
import type { JSX } from 'react';

/**
 * Custom document: sets the dark theme on <html> and preloads the design's
 * Google Fonts (Space Grotesk display, IBM Plex Sans body, JetBrains Mono).
 * The site is dark-only — the design's light theme + live theme toggle were a
 * design-exploration tool and are intentionally not shipped.
 */
export default function Document(): JSX.Element {
  return (
    <Html lang="en" data-theme="dark">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
