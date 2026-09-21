import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { undoBusinessCompensation, type SqlLedgerStore } from '@zichan/db';
import { reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { btnPrimary } from './styles.js';

interface UndoOffer {
  id: number;
  label: string;
  action: () => Promise<void> | void;
}

interface UndoApi {
  offer: (label: string, action: () => Promise<void> | void) => void;
  clear: () => void;
}

const UndoContext = createContext<UndoApi | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  const clear = useCallback(() => {
    setOffer(null);
    setError('');
    setBusy(false);
  }, []);
  const publish = useCallback((label: string, action: () => Promise<void> | void) => {
    setOffer({ id: ++sequence.current, label, action });
    setError('');
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!offer || busy || error) return;
    const timer = window.setTimeout(clear, 10_000);
    return () => window.clearTimeout(timer);
  }, [busy, clear, error, offer]);

  const run = async () => {
    if (!offer || busy) return;
    setBusy(true);
    try {
      await offer.action();
      clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <UndoContext.Provider value={{ offer: publish, clear }}>
      {children}
      {offer && (
        <div role="status" aria-live="polite" className="zc-undo-toast" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', zIndex: 1200, width: 'min(520px, calc(100vw - 24px))', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)', padding: '11px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>{error || offer.label}</span>
          {error ? <button type="button" onClick={clear} style={button}>关闭</button> : <button type="button" onClick={() => void run()} disabled={busy} style={button}>{busy ? '撤销中…' : '撤销'}</button>}
        </div>
      )}
    </UndoContext.Provider>
  );
}

export function useUndo(store?: SqlLedgerStore, onPersistentUndo?: () => void): UndoApi {
  const value = useContext(UndoContext);
  if (!value) throw new Error('useUndo must be used inside UndoProvider');
  const offer = useCallback<UndoApi['offer']>((label, fallback) => {
    if (!store) {
      value.offer(label, fallback);
      return;
    }
    void store.consumeLatestBusinessCompensation()
      .then((compensation) => {
        value.offer(label, async () => {
          if (!compensation || compensation.status !== 'pending') {
            await fallback();
            return;
          }
          await undoBusinessCompensation(store, compensation.id);
          await reconcileAttachmentStorage(store);
          onPersistentUndo?.();
        });
      })
      .catch(() => value.offer(label, fallback));
  }, [onPersistentUndo, store, value]);
  return useMemo(() => ({ offer, clear: value.clear }), [offer, value.clear]);
}

const button = btnPrimary;
