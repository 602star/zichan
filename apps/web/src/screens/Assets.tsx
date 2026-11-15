import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { D, isDefaultAccount } from '@zichan/core';
import type { AccountBalanceAggregateRow } from '@zichan/db';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { buildConvert } from '../selectors/convert.js';
import { baseAsset } from '../db/derive.js';
import { num, signedMoney } from '../format.js';
import { navigateTo, useScreenTarget } from '../screen-target.js';
import { CardAlert, CardEmpty, CardFact } from '../ui/Card.js';
import { MobilePageHeader, TaskList, useMobileSection } from '../ui/MobilePage.js';
import { useTabSet } from '../ui/useTabSet.js';
import { hasMobileDialog } from '../ui/mobile-dialog-history.js';

const Fixed = lazy(() => import('./Fixed.js').then((module) => ({ default: module.Fixed })));
const TABS = ['accounts', 'holdings', 'items'] as const;
type AssetTab = typeof TABS[number];

export function Assets() {
  const { store, rev, preview } = useStore();
  const snap = useSnapshot('convert');
  const target = useScreenTarget('assets');
  const [view, open, back] = useMobileSection('assets');
  const [tab, setTabState] = useState<AssetTab>(() => typeof window !== 'undefined' && TABS.includes(history.state?.zcAssetsTab) ? history.state.zcAssetsTab : 'accounts');
  const setTab = useCallback((next: AssetTab) => { setTabState(next); history.replaceState({ ...history.state, zcAssetsTab: next }, ''); }, []);
  const [balances, setBalances] = useState<AccountBalanceAggregateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const tabs = useTabSet(TABS, tab, setTab);
  const conversion = useMemo(() => snap ? buildConvert(snap) : null, [snap]);
  useEffect(() => {
    const restore = () => { if (!hasMobileDialog() && history.state?.zcScreen === 'assets' && TABS.includes(history.state?.zcAssetsTab)) setTabState(history.state.zcAssetsTab); };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (target?.tab && TABS.includes(target.tab as AssetTab)) setTab(target.tab as AssetTab);
  }, [target, setTab]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void store.accountBalanceAggregates().then((rows) => { if (active) setBalances(rows); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '余额读取失败，请重新打开资产页。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [store, rev]);
  if (!snap || !conversion) return <p role="status">正在读取资产…</p>;
  const base = baseAsset(snap);
  const reportValue = (value: string) => `${num(value, base?.decimals ?? 2)} ${base?.code ?? ''}`.trim();
  const positions = conversion.groups.filter((group) => group.hasPosition && snap.assets.find((asset) => asset.id === group.assetId)?.type !== 'fiat');
  const account = view.startsWith('account:') ? snap.accounts.find((row) => row.id === view.slice(8)) : undefined;
  const holding = view.startsWith('holding:') ? conversion.groups.find((row) => row.assetId === view.slice(8)) : undefined;
  const accountRows = (id: string) => balances.filter((row) => row.accountId === id).map((row) => {
    const asset = snap.assets.find((a) => a.id === row.assetId);
    return { ...row, code: asset?.code ?? row.assetId, amount: row.amounts.reduce((total, amount) => total.plus(amount), D(0)), decimals: asset?.decimals ?? 8 };
  });
  if (account) return <div className="zc-mobile-task-page">
    <MobilePageHeader title={account.name} onBack={back} backLabel="返回资产" />
    <section className="zc-paper-detail" aria-label="账户详情">
      <h2>{account.name}</h2>
      <CardFact label="账户类型" value={({ bank: '银行', cash: '现金', exchange: '交易所', wallet: '钱包', credit_card: '信用卡', loan: '贷款', game_platform: '游戏平台', other: '其他' } as Record<string, string>)[account.kind] ?? '其他'} />
      {accountRows(account.id).map((row) => <CardFact key={row.assetId} label={row.code} tone={row.amount.lt(0) ? 'negative' : 'default'} value={`${num(row.amount, row.decimals)} ${row.code}`} />)}
      {!accountRows(account.id).length && <CardEmpty>{loading ? '正在读取余额…' : '此账户尚无余额记录。'}</CardEmpty>}
    </section>
    <TaskList label="账户操作" items={[
      { label: '查看账户流水', note: '收支、转账和余额变化', onClick: () => navigateTo({ screen: 'transactions', tab: 'accounts', id: account.id }) },
      ...(!preview ? [{ label: '管理账户', onClick: () => navigateTo({ screen: 'manage', tab: 'accounts', id: account.id }) }] : []),
    ]} />
  </div>;
  if (holding) return <div className="zc-mobile-task-page">
    <MobilePageHeader title={holding.assetCode} onBack={back} backLabel="返回持仓" />
    <section className="zc-paper-detail" aria-label="持仓详情">
      <h2>{holding.assetCode}</h2>
      <CardFact label="持有数量" value={`${num(holding.holdings, holding.decimals)} ${holding.assetCode}`} />
      <CardFact label="折算现值" value={holding.value === null ? '缺少价格' : reportValue(holding.value)} />
      <CardFact label="持仓成本" value={holding.costTotal === null ? '成本尚未完整确认' : `${num(holding.costTotal, snap.assets.find((a) => a.id === holding.costCurrencyAssetId)?.decimals ?? 2)} ${snap.assets.find((a) => a.id === holding.costCurrencyAssetId)?.code ?? ''}`} />
      <CardFact label="浮动盈亏" value={holding.pnl === null ? '暂不可完整核算' : signedMoney(holding.pnl, base?.symbol, base?.decimals ?? 2)} />
      {(!holding.costBasisKnown || holding.value === null) && <CardAlert>价格或成本尚不完整。请补充价格，或在资产转换中核对期初持仓与成本。</CardAlert>}
    </section>
    <TaskList label="持仓操作" items={[
      { label: '转换与流水', onClick: () => navigateTo({ screen: 'convert', tab: 'activity', id: holding.assetId }) },
      ...(!preview ? [
        { label: '买入', onClick: () => navigateTo({ screen: 'convert', tab: 'buy', id: holding.assetId }) },
        { label: '卖出', onClick: () => navigateTo({ screen: 'convert', tab: 'sell', id: holding.assetId }) },
        { label: '补充价格', onClick: () => navigateTo({ screen: 'convert', tab: 'price', id: holding.assetId }) },
      ] : []),
    ]} />
  </div>;
  return <div className="zc-mobile-task-page">
    <div className="zc-tabs" role="tablist" aria-label="资产分类">{TABS.map((id) => <button type="button" key={id} {...tabs.tabProps(id)} className={tab === id ? 'zc-tab is-active' : 'zc-tab'}>{({ accounts: '账户', holdings: '持仓', items: '物品' })[id]}</button>)}</div>
    {error && <CardAlert tone="danger">{error}</CardAlert>}
    <div {...tabs.panelProps}>
      {tab === 'accounts' && <>
        <TaskList label="账户列表" items={snap.accounts.filter((row) => row.kind !== 'other' && !isDefaultAccount(row)).map((row) => ({ label: row.name, note: accountRows(row.id).map((b) => `${num(b.amount, b.decimals)} ${b.code}`).join(' · ') || (loading ? '正在读取余额…' : '暂无余额'), onClick: () => open(`account:${row.id}`) }))} />
        {!snap.accounts.some((row) => row.kind !== 'other' && !isDefaultAccount(row)) && <CardEmpty>还没有自行管理的账户，可从添加账户开始。</CardEmpty>}
        {!preview && <button type="button" className="zc-btn zc-btn--primary" onClick={() => navigateTo({ screen: 'manage', tab: 'accounts' })}>添加或管理账户</button>}
      </>}
      {tab === 'holdings' && <>
        <TaskList label="资产持仓" items={positions.map((group) => ({ label: group.assetCode, note: `${num(group.holdings, group.decimals)} ${group.assetCode}`, value: group.value === null ? '缺少价格' : reportValue(group.value), onClick: () => open(`holding:${group.assetId}`) }))} />
        {!positions.length && <CardEmpty>尚无持仓，已有转换记录会自动归入对应资产。</CardEmpty>}
        <TaskList label="转换入口" items={[{ label: '资产转换', note: '换汇、买卖及连续转换', onClick: () => navigateTo({ screen: 'convert' }) }]} />
      </>}
      {tab === 'items' && <Suspense fallback={<p role="status">正在读取物品…</p>}><Fixed navigationKey="assets" /></Suspense>}
    </div>
  </div>;
}
