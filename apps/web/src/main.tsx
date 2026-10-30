import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ClientProvider } from './data/ClientContext';
import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource-variable/spline-sans-mono/wght.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientProvider>
      <App />
    </ClientProvider>
  </StrictMode>,
);
