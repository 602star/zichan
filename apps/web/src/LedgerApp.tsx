import { StoreProvider } from './db/store.js';
import { App } from './App.js';
import { UndoProvider } from './ui/UndoToast.js';
import { CalendarReminderDelivery } from './calendar-reminders.js';

export function LedgerApp() {
  return <StoreProvider><UndoProvider><CalendarReminderDelivery /><App /></UndoProvider></StoreProvider>;
}
