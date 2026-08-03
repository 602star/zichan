import type { CSSProperties } from 'react';

export const card: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 20,
};

export const cardTight: CSSProperties = { ...card, padding: 16 };

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--fg-subtle)',
  letterSpacing: 0,
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  padding: '12px 16px',
  fontSize: 13,
  color: 'var(--fg)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export const tag: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-muted)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  padding: '3px 8px',
  borderRadius: 7,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

export const pillBtn = (active: boolean): CSSProperties => ({
  padding: '9px 16px',
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  background: active ? 'var(--accent-soft)' : 'var(--surface)',
  color: active ? 'var(--accent)' : 'var(--fg-muted)',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
});

export function amountColor(v: number): CSSProperties {
  return {
    fontWeight: 700,
    color: v > 0 ? 'var(--positive)' : v < 0 ? 'var(--negative)' : 'var(--fg-muted)',
  };
}
