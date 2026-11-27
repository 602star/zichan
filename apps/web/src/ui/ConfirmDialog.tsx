import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DialogShell } from './DialogShell.js';

const panel = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  padding: 22,
  width: 460,
  maxWidth: 'calc(100vw - 32px)',
  boxShadow: 'var(--shadow-lg)',
} as const;

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
  secondaryLabel?: string;
  secondaryTone?: 'normal' | 'danger';
  tone?: 'normal' | 'danger';
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  onSecondary?: () => void | Promise<void>;
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

  function runAction(action: () => void | Promise<void>) {
    if (busy || confirmFlight.current) return;
    setActionError('');
    let result: void | Promise<void>;
    try {
      result = action();
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

  function confirm() {
    runAction(props.onConfirm);
  }

  /* Confirm button uses a filled accent/danger look regardless of base button style. */
  const confirmCls = props.tone === 'danger' ? 'zc-btn zc-btn--danger zc-btn--filled' : 'zc-btn zc-btn--primary';
  const secondaryCls = props.secondaryTone === 'danger' ? 'zc-btn zc-btn--danger' : 'zc-btn';
  const confirmExtraStyle = busy || props.confirmDisabled ? { opacity: 0.65 } : undefined;

  return (
    <DialogShell
      labelledBy={titleId}
      describedBy={descriptionId}
      onDismiss={props.onCancel}
      dismissDisabled={busy}
      panelClassName="zc-confirm-panel"
      panelStyle={panel}

      header={<>
        <h2 id={titleId} className="zc-modal-title">{props.title}</h2>
      </>}
      footer={<>
        {actionError && (
          <div role="alert" style={{ marginBottom: 'var(--sp-3)', color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
            操作失败：{actionError}
          </div>
        )}
        <div className={`zc-confirm-actions${props.secondaryLabel && props.onSecondary ? ' has-secondary' : ''}`}>
          {props.secondaryLabel && props.onSecondary && (
            <button type="button" onClick={() => runAction(props.onSecondary!)} disabled={busy} className={secondaryCls}>
              {props.secondaryLabel}
            </button>
          )}
          <div className="zc-confirm-actions-main">
            {props.cancelLabel !== undefined && props.onCancel && (
              <button type="button" data-dialog-initial-focus onClick={props.onCancel} disabled={busy} className="zc-btn">{props.cancelLabel}</button>
            )}
            <button type="button" data-dialog-initial-focus={!props.onCancel ? '' : undefined} onClick={confirm} disabled={busy || props.confirmDisabled} className={confirmCls} style={confirmExtraStyle}>
              {busy ? '处理中…' : props.confirmLabel ?? '确定'}
            </button>
          </div>
        </div>
      </>}
    >

        <div id={descriptionId} style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{props.children}</div>

    </DialogShell>
  );
}
