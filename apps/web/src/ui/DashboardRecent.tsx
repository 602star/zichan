import type { Account, Asset, Transaction } from '@zichan/core';
import { num } from '../format.js';
import { navigateTo } from '../screen-target.js';
import { Card, CardEmpty } from './Card.js';
import { TaskList } from './MobilePage.js';

export function DashboardRecent({ rows, assets, accounts, compact }: { rows: Transaction[]; assets: Asset[]; accounts: Account[]; compact: boolean }) {
  return <Card className="zc-dashboard-recent" title="最近流水" note={`所选期间 · 最近 ${compact ? 3 : 6} 笔`}
    footer={<button type="button" className="zc-workspace-link" onClick={() => navigateTo({ screen: 'transactions', tab: 'records' })}>查看全部流水</button>}>
    {compact && <div className="zc-mobile-shortcuts">
      <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'reports' })}>收支报表</button>
      <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'transactions', tab: 'budget' })}>预算</button>
      <button type="button" className="zc-btn" onClick={() => navigateTo({ screen: 'assets' })}>查看资产</button>
    </div>}
    <TaskList label="最近流水记录" items={rows.slice(0, compact ? 3 : 6).map((row) => {
      const account = accounts.find((item) => item.id === row.accountId);
      const asset = assets.find((item) => item.id === row.assetId);
      const negative = row.type === 'expense' || (row.type === 'adjustment' && row.adjustmentDirection === 'decrease');
      const positive = row.type === 'income' || row.type === 'refund' || (row.type === 'adjustment' && row.adjustmentDirection === 'increase');
      return {
        label: row.description || row.merchant || ({ expense: '支出', income: '收入', refund: '退款', transfer: '转账', adjustment: '余额调整' })[row.type],
        note: `${row.date}${account ? ` · ${account.name}` : ''}`,
        value: <span className={`zc-dashboard-recent-value${negative ? ' is-negative' : positive ? ' is-positive' : ''}`}>{negative ? '−' : positive ? '+' : ''}{num(row.amount, asset?.decimals ?? 8)} {asset?.code ?? row.assetId}</span>,
        onClick: () => navigateTo({ screen: 'transactions', tab: 'records', id: row.id }),
      };
    })} />
    {!rows.length && <CardEmpty>所选期间没有流水，记一笔后会显示在这里。</CardEmpty>}
  </Card>;
}
