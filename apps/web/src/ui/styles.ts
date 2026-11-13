import type { CSSProperties } from 'react';
import { D, type Numeric } from '@zichan/core';

/*
 * Design token–based style helpers that cannot yet be expressed as CSS classes.
 *
 * Everything here is a residual: items that are still used as inline style values
 * because they carry per-instance variation or because they appear inside a computed
 * CSSProperties object (e.g. pillBtn, amountColor). The card/btn families that used
 * to live here have been fully migrated to .zc-card / .zc-btn CSS classes, so they
 * are intentionally absent.
 */

/* The one caption style, so supporting copy stops varying per section. */
export const metaText: CSSProperties = {
  fontSize: 'var(--fs-meta)',
  color: 'var(--text-tertiary)',
  fontWeight: 'var(--fw-regular)',
};

/* A square icon-only action (close, step, paginate). */
export const iconBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  width: 34,
  height: 34,
  padding: 0,
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--surface)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-title)',
  fontWeight: 'var(--fw-medium)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

/* A borderless text action that reads as a link. */
export const linkAccent: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--accent)',
  padding: 0,
  fontSize: 'var(--fs-caption)',
  fontWeight: 'var(--fw-medium)',
  cursor: 'pointer',
};

/* A text-only destructive action (no border, no background). */
export const linkDanger: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--negative)',
  padding: 0,
  fontSize: 'var(--fs-caption)',
  fontWeight: 'var(--fw-medium)',
  cursor: 'pointer',
};

export const inputBase: CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
};

export const selectBase: CSSProperties = {
  ...inputBase,
  padding: '8px 10px',
  fontWeight: 'var(--fw-medium)',
  cursor: 'pointer',
};

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 'var(--fs-meta)',
  fontWeight: 'var(--fw-medium)',
  color: 'var(--text-tertiary)',
  letterSpacing: 0,
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  padding: '12px 16px',
  fontSize: 'var(--fs-body)',
  color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export const tag: CSSProperties = {
  fontSize: 'var(--fs-meta)',
  color: 'var(--text-secondary)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  padding: '3px 8px',
  borderRadius: 'var(--r-sm)',
  fontWeight: 'var(--fw-medium)',
  whiteSpace: 'nowrap',
};

export const pillBtn = (active: boolean): CSSProperties => ({
  padding: '9px 16px',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-body)',
  fontWeight: 'var(--fw-bold)',
  cursor: 'pointer',
  background: active ? 'var(--accent-soft)' : 'var(--surface)',
  color: active ? 'var(--accent)' : 'var(--fg-muted)',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
});

export function amountColor(v: Numeric): CSSProperties {
  const amount = D(v);
  return {
    fontWeight: 'var(--fw-bold)',
    color: amount.isPositive() && !amount.isZero()
      ? 'var(--positive)'
      : amount.isNegative() && !amount.isZero() ? 'var(--negative)' : 'var(--fg-muted)',
  };
}
