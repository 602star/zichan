import { useEffect, type ReactNode } from 'react';

const panel = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 22,
  width: 460,
  maxWidth: 'calc(100vw - 32px)',
  boxShadow: '0 22px 70px rgba(15, 23, 42, .24)',
} as const;

const button = {
  padding: '9px 16px',
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg-muted)',
  fontWeight: 800,
  fontSize: 13,
  cursor: 'pointer',
} as const;

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
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const confirmStyle = props.tone === 'danger'
    ? { ...button, border: '1px solid var(--negative)', background: 'var(--negative)', color: '#fff' }
    : { ...button, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' };

  return (
    <div className="zc-backdrop" onClick={props.onCancel}>
      <div className="zc-confirm-panel" style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 900, marginBottom: 10 }}>{props.title}</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.65 }}>{props.children}</div>
        <div className="zc-confirm-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          {props.cancelLabel !== undefined && props.onCancel && (
            <button onClick={props.onCancel} disabled={props.busy} style={button}>{props.cancelLabel}</button>
          )}
          <button onClick={() => void props.onConfirm()} disabled={props.busy} style={{ ...confirmStyle, opacity: props.busy ? 0.65 : 1 }}>
            {props.busy ? '处理中…' : props.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
