import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { StoreProvider } from './db/store.js';
import { App } from './App.js';
import { UndoProvider } from './ui/UndoToast.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <UndoProvider>
        <App />
      </UndoProvider>
    </StoreProvider>
  </StrictMode>,
);
