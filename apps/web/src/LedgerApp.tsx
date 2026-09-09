import { StoreProvider } from './db/store.js';
import { App } from './App.js';
import { UndoProvider } from './ui/UndoToast.js';

export function LedgerApp() {
  return <StoreProvider><UndoProvider><App /></UndoProvider></StoreProvider>;
}
