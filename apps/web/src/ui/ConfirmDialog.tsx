import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DialogShell } from './DialogShell.js';
import { btnOutline } from './styles.js';

const panel = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  padding: 22,
  width: 460,
  maxWidth: 'calc(100vw - 32px)',
  boxShadow: '0 22px 70px rgba(15, 23, 42, .24)',
} as const;

const button = btnOutline;

export function confirmDialogErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '操作失败，请稍后重试';
}

export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'normal' | 'danger';
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [internalBusy, setInternalBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const confirmFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const busy = !!props.busy || internalBusy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      confirmFlight.current = null;
    };
  }, []);

  function confirm() {
    if (busy || confirmFlight.current) return;
    setActionError('');
    let result: void | Promise<void>;
    try {
      result = props.onConfirm();
    } catch (error) {
      setActionError(confirmDialogErrorMessage(error));
      return;
    }
    if (!result || typeof result.then !== 'function') return;
    setInternalBusy(true);
    const flight = Promise.resolve(result);
    confirmFlight.current = flight;
    void flight.catch((error: unknown) => {
      if (mounted.current && confirmFlight.current === flight) {
        setActionError(confirmDialogErrorMessage(error));
      }
    }).finally(() => {
      if (confirmFlight.current !== flight) return;
      confirmFlight.current = null;
      if (mounted.current) setInternalBusy(false);
    });
  }

  const confirmStyle = props.tone === 'danger'
    ? { ...button, border: '1px solid var(--negative)', background: 'var(--negative)', color: '#fff' }
    : { ...button, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' };

  return (
    <DialogShell
      labelledBy={titleId}
      describedBy={descriptionId}
      onDismiss={props.onCancel}
      dismissDisabled={busy}
      panelClassName="zc-confirm-panel"
      panelStyle={panel}
    >
        <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>{props.title}</div>
        <div id={descriptionId} style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{props.children}</div>
        {actionError && (
          <div role="alert" style={{ marginTop: 12, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
            操作失败：{actionError}
          </div>
        )}
        <div className="zc-confirm-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          {props.cancelLabel !== undefined && props.onCancel && (
            <button data-dialog-initial-focus onClick={props.onCancel} disabled={busy} style={button}>{props.cancelLabel}</button>
          )}
          <button data-dialog-initial-focus={!props.onCancel ? '' : undefined} onClick={confirm} disabled={busy} style={{ ...confirmStyle, opacity: busy ? 0.65 : 1 }}>
            {busy ? '处理中…' : props.confirmLabel ?? '确定'}
          </button>
        </div>
    </DialogShell>
  );
}
