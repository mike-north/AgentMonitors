import type { AppProps } from 'next/app';
import type { ReactNode } from 'react';
import Head from 'next/head';

function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          color: '#111827',
          backgroundColor: '#ffffff',
        }}
      >
        <header
          style={{
            borderBottom: '1px solid #e5e7eb',
            padding: '0.75rem 2rem',
            display: 'flex',
            alignItems: 'center',
            gap: '2rem',
            position: 'sticky',
            top: 0,
            backgroundColor: '#ffffff',
            zIndex: 10,
          }}
        >
          <a
            href="/"
            style={{
              fontWeight: 700,
              fontSize: '1rem',
              textDecoration: 'none',
              color: '#111827',
              whiteSpace: 'nowrap',
            }}
          >
            Agent Monitors
          </a>
          <nav
            style={{
              display: 'flex',
              gap: '1.5rem',
              fontSize: '0.875rem',
              flexWrap: 'wrap',
            }}
          >
            <a href="/docs/getting-started" style={{ color: '#374151', textDecoration: 'none' }}>
              Getting started
            </a>
            <a href="/docs/authoring-monitors" style={{ color: '#374151', textDecoration: 'none' }}>
              Authoring
            </a>
            <a href="/docs/use-cases" style={{ color: '#374151', textDecoration: 'none' }}>
              Use cases
            </a>
            <a href="/docs/monitor-standard" style={{ color: '#374151', textDecoration: 'none' }}>
              Standard
            </a>
          </nav>
        </header>
        <main
          style={{
            flex: 1,
            maxWidth: '52rem',
            width: '100%',
            margin: '0 auto',
            padding: '2rem 1.5rem',
          }}
        >
          {children}
        </main>
        <footer
          style={{
            borderTop: '1px solid #e5e7eb',
            padding: '1.5rem 2rem',
            textAlign: 'center',
            color: '#6b7280',
            fontSize: '0.8125rem',
          }}
        >
          Agent Monitors &mdash; Peripheral vision for your coding agent &mdash;{' '}
          <a
            href="https://github.com/mike-north/AgentMonitors"
            style={{ color: '#6b7280' }}
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </footer>
      </div>
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
