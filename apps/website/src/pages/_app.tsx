import type { AppProps } from 'next/app';
import type { JSX } from 'react';
import { useRouter } from 'next/router';
import { Footer, Nav } from '../components/landing/sections';
import '../styles/landing.css';

/**
 * App shell. The whole site uses the dark, engineer-warm theme ported from the
 * design bundle (tokens in landing.css, applied via _document's data-theme).
 *
 * The landing page ("/") is full-bleed and supplies its own nav/footer through
 * Markdoc tags, so it renders bare. Docs pages render the shared marketing nav,
 * a readable prose column, and the shared footer.
 */
export default function App({ Component, pageProps }: AppProps): JSX.Element {
  const router = useRouter();
  const isLanding = router.pathname === '/';

  if (isLanding) {
    return (
      <div className="app">
        <Component {...pageProps} />
      </div>
    );
  }

  return (
    <div className="app" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Nav />
      <main className="docs-prose" style={{ flex: 1 }}>
        <Component {...pageProps} />
      </main>
      <Footer />
    </div>
  );
}
