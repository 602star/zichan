import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isLegacyExternalAccount, isSystemDefaultAccount, type Account, type ReconciliationSession } from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import type { AccountBalanceVM } from '../selectors/transactions.js';
import { ACCOUNT_KINDS } from '../account-fields.js';
import { num } from '../format.js';
import { Card, CardAlert, CardEmpty, CardFact, CardGroup } from './Card.js';
import { AccountDefaultSettings } from './AccountDefaultSettings.js';
import { DateRangeBar, type DateRangeValue } from './DateRangeBar.js';
import { ValuePicker } from './ValuePicker.js';
import { TaskList } from './MobilePage.js';
import { useCompactView } from './useCompactView.js';
import { useTabSet } from './useTabSet.js';

export interface AccountWorkspaceLedgerRow { id: string; date: string; title: string; categoryLabel: string; statusLabel: string; amount: string; displayAmount: string; balance: string; assetCode: string; }
interface Props {
  snap: Snapshot; balances: AccountBalanceVM[]; selectedId: string; assetId: string; accountAssets: string[];
  readOnly?: boolean;
  balancesBusy: boolean; balanceError: string; ledgerError: string; onRetryRead: () => void;
  range: DateRangeValue; onRangeChange: (value: DateRangeValue) => void;
  onSelect: (id: string) => void; onAssetChange: (id: string) => void;
  onAdd: () => void; onEdit: (account: Account) => void; onEarlier: (account: Account) => void;
  onReconcile: (session?: ReconciliationSession) => void; onHistory: () => void; onRecords: (id: string) => void;
  ledger: AccountWorkspaceLedgerRow[]; ledgerBusy: boolean; loadingMore: boolean; hasMore: boolean; totalCount: number; onLoadMore: () => void;
}
const DETAIL_TABS = [['ledger', '账户流水'], ['reconciliations', '对账记录'], ['profile', '账户资料']] as const;
type DetailTab = typeof DETAIL_TABS[number][0];

export function AccountsWorkspace(props: Props) {
  const compact = useCompactView();
  const id = useId();
  const detailAnchor = useRef<HTMLDivElement>(null);
  const { snap, balances, selectedId } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [tab, setTab] = useState<DetailTab>('ledger');
  useEffect(() => { setTab('ledger'); }, [selectedId]);
  const funds = snap.accounts.filter((account) => !account.isDeleted && !isLegacyExternalAccount(account));
  const selected = funds.find((account) => account.id === selectedId);
  const detailTabs = DETAIL_TABS.filter(([id]) => id !== 'reconciliations' || !selected || !isSystemDefaultAccount(selected)
    || snap.reconciliationSessions.some((session) => session.accountId === selectedId));
  const activeTab = detailTabs.some(([id]) => id === tab) ? tab : 'ledger';
  const tabs = useTabSet(detailTabs.map(([id]) => id), activeTab, setTab);
  const isActive = (account: Account) => account.isActive !== false && !account.archivedAt;
  const shown = funds.filter((account) => `${account.name} ${account.platform ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    && (status === 'all' || isActive(account) === (status === 'active')));
  const typeLabel = (account: Account) => ACCOUNT_KINDS.find((kind) => kind.value === account.kind)?.label ?? '其他';
  const balanceRows = (account: Account) => {
    const rows = balances.filter((row) => row.accountId === account.id);
    if (rows.length || !account.openingAssetId) return rows;
    const asset = snap.assets.find((row) => row.id === account.openingAssetId);
    return asset ? [{ accountId: account.id, accountName: account.name, assetId: asset.id, assetCode: asset.code, amount: '0' }] : [];
  };
  const formattedBalance = (account: Account): ReactNode => {
    if (props.balanceError) return '余额读取失败';
    if (props.balancesBusy) return '正在读取余额…';
    const rows = balanceRows(account);
    return rows.length ? <span className="zc-account-balances">{rows.map((row) => <span key={row.assetId} className={row.amount.startsWith('-') ? 'is-negative' : ''}>{num(row.amount, snap.assets.find((asset) => asset.id === row.assetId)?.decimals ?? 8)} {row.assetCode}</span>)}</span> : '未设置余额起点';
  };
  const roles = (account: Account) => <span className="zc-account-role-badges">
    {snap.setting?.expenseDefaultAccountId === account.id && <span>默认支出</span>}
    {snap.setting?.incomeDefaultAccountId === account.id && <span>默认收入</span>}
    {!isActive(account) && <span className="is-inactive">{account.archivedAt ? '已归档' : '已停用'}</span>}
    {isActive(account) && snap.setting?.expenseDefaultAccountId !== account.id && snap.setting?.incomeDefaultAccountId !== account.id && <span>启用</span>}
  </span>;
  const sessions = snap.reconciliationSessions.filter((session) => session.accountId === selectedId
    && (!props.range.from || session.statementDate >= props.range.from) && (!props.range.to || session.statementDate <= props.range.to));
  function selectAccount(accountId: string) {
    props.onSelect(accountId);
    requestAnimationFrame(() => {
      const anchor = detailAnchor.current;
      anchor?.scrollIntoView({ block: 'start' });
      const heading = anchor?.querySelector('h2');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    });
  }
  return <div className="zc-accounts-workspace">
    <AccountDefaultSettings accounts={snap.accounts} setting={snap.setting} />
    <Card title="资金账户" note={`${funds.length} 个账户 · 按原币查看余额`} action={<button type="button" className="zc-btn zc-btn--primary" disabled={props.readOnly} onClick={props.onAdd}>添加银行卡 / 钱包</button>}>
      <div className="zc-account-list-tools"><input className="zc-input" aria-label="搜索资金账户" placeholder="搜索名称或平台" value={search} onChange={(event) => setSearch(event.target.value)} />
        <ValuePicker id={`${id}-status`} label="账户状态筛选" value={status} options={[{ value: 'all', label: '全部状态' }, { value: 'active', label: '仅启用' }, { value: 'inactive', label: '停用与归档' }]} onChange={setStatus} /></div>
      {props.balanceError && <CardAlert tone="danger" role="alert">账户余额读取失败：{props.balanceError}。<button type="button" className="zc-workspace-link" onClick={props.onRetryRead}>重新读取账户</button></CardAlert>}
      {!shown.length ? <CardEmpty>{funds.length ? '没有匹配的账户，请调整搜索或状态。' : '添加银行卡、钱包或现金账户后，可查看余额与核对账单；也可以继续用系统默认账户记收支。'}</CardEmpty> : compact
        ? <TaskList label="资金账户清单" items={shown.map((account) => ({ label: account.name, note: <>{typeLabel(account)}{roles(account)}</>, value: formattedBalance(account), onClick: () => selectAccount(account.id) }))} />
        : <div className="zc-account-table-wrap"><table className="zc-workspace-table zc-account-list-table"><thead><tr><th>账户</th><th>类型与平台</th><th>原币余额</th><th>默认用途 / 状态</th><th>余额起点</th></tr></thead>
          <tbody>{shown.map((account) => <tr key={account.id} className={selectedId === account.id ? 'is-selected' : ''}><td><button type="button" className="zc-workspace-link" aria-pressed={selectedId === account.id} onClick={() => selectAccount(account.id)}>{account.name}</button></td>
            <td>{typeLabel(account)}{account.platform && <small>{account.platform}</small>}</td><td>{formattedBalance(account)}</td><td>{roles(account)}</td><td>{account.balanceStartDate ?? '未设置'}</td></tr>)}</tbody></table></div>}
      <div className="zc-account-list-foot"><span>余额包含收支、转账和资产转换；不同币种分别列示。</span><button type="button" className="zc-workspace-link" disabled={props.readOnly} onClick={props.onHistory}>整理以前的记录</button></div>
    </Card>
    {selected && <div ref={detailAnchor} className="zc-account-detail-anchor"><Card title={selected.name} className="zc-account-workspace-detail" note={`${typeLabel(selected)}${selected.archivedAt ? ' · 已归档' : selected.isActive === false ? ' · 已停用' : ''}`}
      action={<div className="zc-mobile-shortcuts">{!isSystemDefaultAccount(selected) && <button type="button" className="zc-btn zc-btn--primary" disabled={!isActive(selected) || props.readOnly} onClick={() => props.onReconcile()}>核对账单</button>}<button type="button" className="zc-btn" disabled={props.readOnly} onClick={() => props.onEdit(selected)}>编辑账户</button></div>}>
      <div className="zc-account-selected-balances">{formattedBalance(selected)}{roles(selected)}</div>
      <div className="zc-tabs" role="tablist" aria-label="账户工作区">{detailTabs.map(([id, label]) => <button key={id} type="button" className={activeTab === id ? 'zc-tab is-active' : 'zc-tab'} {...tabs.tabProps(id)}>{label}</button>)}</div>
      {activeTab !== 'profile' && <DateRangeBar value={props.range} onChange={props.onRangeChange} />}
      <section {...tabs.panelProps}>
        {activeTab === 'ledger' && <>
          <div className="zc-account-ledger-tools"><ValuePicker id={`${id}-asset`} label="账户流水币种" value={props.assetId} options={[{ value: 'all', label: '全部币种' }, ...props.accountAssets.map((id) => ({ value: id, label: snap.assets.find((asset) => asset.id === id)?.code ?? id }))]} onChange={props.onAssetChange} />
            <button type="button" className="zc-workspace-link" onClick={() => props.onRecords(selected.id)}>查看这个账户的日常收支</button></div>
          {props.ledgerError ? <CardAlert tone="danger" role="alert">账户流水读取失败：{props.ledgerError}。<button type="button" className="zc-workspace-link" onClick={props.onRetryRead}>重新读取账户</button></CardAlert> : props.ledgerBusy ? <p role="status">正在读取账户流水…</p> : props.ledger.length ? <div className="zc-account-table-wrap"><table className="zc-workspace-table zc-card-table"><thead><tr>{['日期', '摘要', '分类', '状态', '金额', '余额'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>
            {props.ledger.map((row) => <tr key={row.id}><td data-label="日期">{row.date}</td><td data-label="摘要">{row.title}</td><td data-label="分类">{row.categoryLabel}</td><td data-label="状态">{row.statusLabel}</td><td data-label="金额" className={`is-numeric${row.amount.startsWith('-') ? ' is-negative' : ''}`}>{row.displayAmount} {row.assetCode}</td><td data-label="余额" className="is-numeric">{num(row.balance, snap.assets.find((asset) => asset.code === row.assetCode)?.decimals ?? 8)} {row.assetCode}</td></tr>)}
          </tbody></table></div> : <CardEmpty>所选期间没有账户流水，可调整日期或登记新的收支。</CardEmpty>}
          {props.hasMore && !props.ledgerError && <button type="button" className="zc-btn zc-account-load-more" onClick={props.onLoadMore} disabled={props.ledgerBusy || props.loadingMore}>{props.loadingMore ? '正在加载…' : `继续加载 100 笔（已加载 ${props.ledger.length} / ${props.totalCount}）`}</button>}
        </>}
        {activeTab === 'reconciliations' && (sessions.length ? <div className="zc-account-table-wrap"><table className="zc-workspace-table zc-card-table"><thead><tr>{['账单日', '账单余额', '差额', '状态', '操作'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{sessions.map((session) => {
          const asset = snap.assets.find((row) => row.id === session.assetId);
          return <tr key={session.id}><td data-label="账单日">{session.statementDate}</td><td data-label="账单余额" className="is-numeric">{num(session.statementBalance, asset?.decimals ?? 8)} {asset?.code}</td><td data-label="差额" className="is-numeric">{num(session.difference, asset?.decimals ?? 8)} {asset?.code}</td><td data-label="状态">{session.status === 'closed' ? '已完成' : '进行中'}</td><td data-label="操作"><button type="button" className="zc-btn zc-btn--sm" onClick={() => props.onReconcile(session)}>查看对账</button></td></tr>;
        })}</tbody></table></div> : <CardEmpty>{isSystemDefaultAccount(selected) ? '系统预建账户不进行账单对账，收支与余额仍正常记录。' : '这个账户在所选期间没有对账记录，可从“核对账单”开始。'}</CardEmpty>)}
        {activeTab === 'profile' && <CardGroup className="zc-account-profile">
          <CardFact label="账户名称" value={selected.name} /><CardFact label="账户类型" value={typeLabel(selected)} />
          {selected.platform && <CardFact label="平台" value={selected.platform} />}
          <CardFact label="余额起点" value={selected.balanceStartDate ?? '未设置'} /><CardFact label="起始余额" value={selected.openingBalance == null ? '未设置' : `${num(selected.openingBalance, snap.assets.find((asset) => asset.id === selected.openingAssetId)?.decimals ?? 8)} ${snap.assets.find((asset) => asset.id === selected.openingAssetId)?.code ?? ''}`} />
          {selected.statementDay && <CardFact label="账单日" value={`每月 ${selected.statementDay} 日`} />}{selected.paymentDueDay && <CardFact label="还款日" value={`每月 ${selected.paymentDueDay} 日`} />}
          {selected.note && <CardFact label="备注" value={selected.note} />}
          {selected.balanceStartAt && <button type="button" className="zc-workspace-link" disabled={props.readOnly} onClick={() => props.onEarlier(selected)}>从更早日期核算</button>}
        </CardGroup>}
      </section>
    </Card></div>}
  </div>;
}
