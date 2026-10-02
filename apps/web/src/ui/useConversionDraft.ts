import { useEffect, useRef, useState } from 'react';
import { createConversionDraftStore, type ConversionDraft } from '../db/conversion-drafts.js';
import { requireLedgerCryptoSession } from '../ledger-key-vault.js';

export function useConversionDraft<T extends object>(values: T, restore: (values: T) => void, recordId?: string, entityVersion?: number) {
  const [storage] = useState(() => {
    try { return createConversionDraftStore<T>(requireLedgerCryptoSession(), recordId); }
    catch { return null; }
  });
  const [pending, setPending] = useState<ConversionDraft<T> | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState(false);
  const baseline = useRef(JSON.stringify(values));
  const submitted = useRef(false);
  const current = useRef(values);
  current.current = values;
  const fingerprint = JSON.stringify(values);
  const dirty = fingerprint !== baseline.current;
  useEffect(() => {
    let active = true;
    if (!storage) { setError('账本密钥未解锁，无法保存加密草稿'); return; }
    void storage.load().then((draft) => {
      if (!active) return;
      setPending(draft);
      setReady(!draft);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [storage]);
  useEffect(() => {
    if (!ready || !dirty || submitted.current || conflict || !storage) return;
    const timer = setTimeout(() => {
      void storage.save(current.current, entityVersion).then(() => {
        if (!submitted.current) { setStatus('草稿已加密保存在本机'); setError(''); }
      }).catch((cause: unknown) => setError(`草稿保存失败：${cause instanceof Error ? cause.message : String(cause)}`));
    }, 500);
    return () => clearTimeout(timer);
  }, [fingerprint, dirty, ready, storage, entityVersion, conflict]);
  useEffect(() => {
    if (!dirty || submitted.current) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return {
    dirty, pending, error, status, conflict,
    resume() {
      if (!pending) return;
      setConflict(pending.entityVersion !== entityVersion);
      restore(pending.values);
      setPending(null); setReady(true);
    },
    async discard() {
      if (!storage) throw new Error('草稿存储不可用');
      await storage.clear(); setPending(null); setReady(true); setConflict(false); setStatus(''); setError('');
    },
    confirmConflict() { setConflict(false); },
    async keep() {
      if (!storage || !ready || conflict) throw new Error('请先处理草稿恢复或版本差异');
      await storage.save(current.current, entityVersion);
    },
    async finish() {
      submitted.current = true;
      if (storage) await storage.finish();
    },
  };
}
