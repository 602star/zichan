import { useState } from 'react';
import type { AsOfMode } from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { draftSetting, saveLedgerSetting } from '../db/ledger-settings.js';
import { ledgerAsOf, needsAsOfAttention } from '../as-of.js';
import { btnOutline, cardTight, linkAccent } from './styles.js';

/**
 * The ledger cut-off (「账本日」) freezes at sign-up and never advances on its
 * own, so without this notice later records silently drop out of every report
 * and every valuation. It is shown on the two screens where that would otherwise
 * be invisible, and it carries the one click that fixes it.
 */
export function LedgerCutoffNotice({ snap }: { snap: Snapshot }) {
  const { store, bump } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = ledgerAsOf(snap);
  if (!needsAsOfAttention(state)) return null;
  // Not future-dated, so this is the manual cut-off that has fallen behind.
  const behind = state.stale && state.mode === 'manual';

  const days = Math.abs(state.daysBehind);

  async function apply(patch: { asOfDate: string; asOfMode?: AsOfMode }, label: string) {
    setBusy(true);
    setError('');
    try {
      await saveLedgerSetting(
        store,
        snap.setting,
        draftSetting(snap.setting?.baseCurrencyAssetId ?? '', state.today),
        patch,
        label,
      );
      bump();
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim() ? cause.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="zc-cutoff-notice"
      style={{
        ...cardTight,
        borderColor: 'var(--warning)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', color: 'var(--warning)' }}>
          {behind ? `账本日停在 ${state.asOf}，比今天早 ${days} 天` : `账本日设在 ${state.asOf}，比今天晚 ${days} 天`}
        </div>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
          {behind
            ? '这之后的流水不会计入报表，净资产也按该日的价格估值。更新后即可恢复。'
            : '报表会包含预记账的日期，指标可能提前反映还没发生的收支。'}
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', marginTop: 6 }}>
            更新失败：{error}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply({ asOfDate: state.today }, '更新账本日')}
          style={{ ...btnOutline, opacity: busy ? 0.65 : 1 }}
        >
          {busy ? '处理中…' : `更新到今天 · ${state.today}`}
        </button>
        {behind && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply({ asOfDate: state.today, asOfMode: 'auto_today' }, '账本日改为自动跟进')}
            style={{ ...linkAccent, opacity: busy ? 0.65 : 1 }}
          >
            以后自动跟到今天
          </button>
        )}
      </div>
    </div>
  );
}
