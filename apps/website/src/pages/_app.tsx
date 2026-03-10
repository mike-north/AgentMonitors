import type { AppProps } from 'next/app';
import type { ReactNode } from 'react';
import Head from 'next/head';

function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Head>
        <title>Agent Monitors</title>
        <meta
          name="description"
          content="Durable observation and inbox delivery for AI agents"
        />
      </Head>
      <header
        style={{
          borderBottom: '1px solid #e5e7eb',
          padding: '1rem 2rem',
          display: 'flex',
          alignItems: 'center',
          gap: '2rem',
        }}
      >
        <a
          href="/"
          style={{
            fontWeight: 'bold',
            fontSize: '1.25rem',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          Agent Monitors
        </a>
        <nav style={{ display: 'flex', gap: '1rem' }}>
          <a href="/docs/getting-started">Docs</a>
          <a href="/docs/concepts">Concepts</a>
          <a href="/docs/authoring-monitors">Authoring</a>
        </nav>
      </header>
      <main
        style={{
          maxWidth: '48rem',
          margin: '2rem auto',
          padding: '0 1rem',
        }}
      >
        {children}
      </main>
      <footer
        style={{
          borderTop: '1px solid #e5e7eb',
          padding: '1rem 2rem',
          textAlign: 'center',
          color: '#6b7280',
          fontSize: '0.875rem',
        }}
      >
        Agent Monitors &mdash; Durable observation for AI agents
      </footer>
    </>
  );
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <Layout>
      <Component {...pageProps} />
    </Layout>
  );
}
