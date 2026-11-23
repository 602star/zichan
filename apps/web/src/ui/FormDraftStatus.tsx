import { useEffect, useRef, useState } from 'react';

type DraftSaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; savedAt: string }
  | { state: 'error'; message: string };

export function useFormDraftAutosave(
  enabled: boolean,
  fingerprint: string,
  save: () => Promise<{ savedAt: string }>,
): { status: DraftSaveStatus; drainPending: () => Promise<void>; stopAndDrain: () => Promise<void> } {
  const [status, setStatus] = useState<DraftSaveStatus>({ state: 'idle' });
  const saveRef = useRef(save);
  const timerRef = useRef<number | undefined>(undefined);
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  const stoppedRef = useRef(false);
  saveRef.current = save;

  useEffect(() => {
    if (!enabled || stoppedRef.current) return;
    let active = true;
    setStatus({ state: 'saving' });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      if (stoppedRef.current) return;
      const saveCurrent = saveRef.current;
      const flight = tailRef.current.then(() => saveCurrent());
      // Keep writes in edit order, and allow a later edit to retry after failure.
      tailRef.current = flight.then(() => undefined, () => undefined);
      void flight.then(
        (draft) => { if (active && !stoppedRef.current) setStatus({ state: 'saved', savedAt: draft.savedAt }); },
        (error: unknown) => {
          if (active && !stoppedRef.current) setStatus({
            state: 'error',
            message: error instanceof Error && error.message ? error.message : '浏览器存储写入失败',
          });
        },
      );
    }, 500);
    return () => {
      active = false;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [enabled, fingerprint]);

  return {
    status,
    drainPending: async () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      await tailRef.current;
    },
    stopAndDrain: async () => {
      stoppedRef.current = true;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      await tailRef.current;
    },
  };
}

export function FormDraftStatus({ status, compact = false }: { status: DraftSaveStatus; compact?: boolean }) {
  if (status.state === 'idle') return null;
  const failed = status.state === 'error';
  return (
    <div
      className={`zc-form-draft-status${failed ? ' is-error' : ''}`}
      role={failed ? 'alert' : 'status'}
      title={status.state === 'saved' ? new Date(status.savedAt).toLocaleString() : undefined}
      style={{ marginTop: compact && !failed ? 0 : 10, marginBottom: compact && !failed ? 8 : undefined, padding: compact && !failed ? 0 : '8px 10px', border: compact && !failed ? 0 : '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: compact && !failed ? 'transparent' : 'var(--surface-2)', color: failed ? 'var(--negative)' : 'var(--text-secondary)', fontSize: compact && !failed ? 'var(--fs-meta)' : 'var(--fs-caption)' }}
    >
      {failed
        ? `草稿自动保存失败：${status.message}。当前修改仍在本页，请保持页面打开并尝试继续编辑或手动保存。`
        : status.state === 'saving'
          ? '正在自动保存草稿…'
          : compact ? '草稿已自动保存' : `草稿已自动保存：${new Date(status.savedAt).toLocaleString()}`}
    </div>
  );
}
