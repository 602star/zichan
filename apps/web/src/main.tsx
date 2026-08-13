import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { StoreProvider } from './db/store.js';
import { App } from './App.js';
import { UndoProvider } from './ui/UndoToast.js';
import { AppErrorBoundary } from './ui/AppErrorBoundary.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <StoreProvider>
        <UndoProvider>
          <App />
        </UndoProvider>
      </StoreProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
