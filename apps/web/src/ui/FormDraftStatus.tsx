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

export function FormDraftStatus({ status }: { status: DraftSaveStatus }) {
  if (status.state === 'idle') return null;
  const failed = status.state === 'error';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', color: failed ? 'var(--negative)' : 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}
    >
      {failed
        ? `草稿自动保存失败：${status.message}。当前修改仍在本页，请保持页面打开并尝试继续编辑或手动保存。`
        : status.state === 'saving'
          ? '正在自动保存草稿…'
          : `草稿已自动保存：${new Date(status.savedAt).toLocaleString()}`}
    </div>
  );
}
