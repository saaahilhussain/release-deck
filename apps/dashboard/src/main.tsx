import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function App() {
  return (
    <main className="page-shell">
      <section className="hero-card" aria-labelledby="page-title">
        <p className="wordmark">ReleaseDeck</p>
        <p className="eyebrow">Phase 1 foundation</p>
        <h1 id="page-title">Self-Hosted Release &amp; Deployment Platform</h1>
        <p className="tagline">Build. Release. Roll back.</p>
        <p className="hero-copy">
          A focused workspace foundation for teams that ship and operate their own
          software.
        </p>
        <p className="foundation-note">
          Foundation scaffold — deployment features arrive in later phases.
        </p>
      </section>

      <footer className="page-footer">
        <span>ReleaseDeck</span>
        <span className="footer-separator" aria-hidden="true">
          /
        </span>
        <span>Workspace foundation</span>
      </footer>
    </main>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Dashboard root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
