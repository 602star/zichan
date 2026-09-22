import { useEffect, useState } from 'react';
import type { Payee } from '@zichan/core';
import { useStore } from '../db/store.js';
import type { Snapshot } from '../db/snapshot.js';
import { catalogPayeeId, matchingPayee, normalizedPayeeName, PAYEE_SCENES, PLATFORM_CATALOG, type PlatformEntry } from '../payee-catalog.js';
import { payeeForm } from '../forms.js';
import { EntityFormModal } from './EntityFormModal.js';
import { EntityIcon } from './EntityIcon.js';
import { btnOutline } from './styles.js';

export function PayeeDirectory({ snap }: { snap: Snapshot }) {
  const { store, rev, bump } = useStore();
  const [scene, setScene] = useState('all');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState<Payee[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ entry: PlatformEntry; initial: Payee; isNew: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void store.payees.list({ includeDeleted: true }).then((rows) => { if (active) { setAll(rows); setError(''); } })
      .catch(() => { if (active) { setAll(null); setError('平台资料读取失败，请重新打开平台目录'); } });
    return () => { active = false; };
  }, [store, rev]);
  const rows = PLATFORM_CATALOG.filter((entry) => scene === 'all' || entry.scenes.some((id) => id === scene))
    .filter((entry) => {
      const existing = matchingPayee(all ?? [], entry.name, entry);
      return [entry.name, ...entry.aliases, existing?.name ?? '', ...(existing?.aliases ?? [])].some((name) => normalizedPayeeName(name).includes(normalizedPayeeName(query)));
    });
  return <section aria-label="平台目录">
    <p className="zc-meta">按场景查找平台。添加后可设置图标、别名、默认分类与账户；已添加的平台直接编辑同一条资料。</p>
    <div className="zc-payee-directory-filters">
      <input className="zc-input" aria-label="搜索平台目录" placeholder="搜索平台名称或别名" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select className="zc-select" aria-label="平台场景" value={scene} onChange={(event) => setScene(event.target.value)}>
        <option value="all">全部场景</option>{PAYEE_SCENES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="zc-payee-directory-grid">
      {rows.map((entry) => {
        const existing = matchingPayee(all ?? [], entry.name, entry);
        return <div className="zc-payee-directory-card" key={entry.id}>
          <span className="zc-entity-name"><EntityIcon icon={existing?.icon} platformId={entry.id} platformName={entry.name} fallback="store" /><b>{existing?.name ?? entry.name}</b></span>
          <span className="zc-meta">{existing && existing.name !== entry.name ? `${entry.name} · ` : ''}{entry.scenes.map((id) => PAYEE_SCENES.find((item) => item.id === id)?.name).join('、')}{existing?.isActive === false ? ' · 已停用' : ''}</span>
          <button type="button" style={btnOutline} disabled={!all || existing?.isDeleted === true} onClick={() => setEditing({ entry, isNew: !existing, initial: existing ?? {
            id: catalogPayeeId(entry), name: entry.name, aliases: [entry.name, ...entry.aliases], isActive: true,
            createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          } })}>{existing?.isDeleted ? '已删除' : existing ? '编辑交易对象' : '添加并编辑'}</button>
        </div>;
      })}
    </div>
    {!rows.length && <p className="zc-meta">没有匹配的平台，也可以在“我的交易对象”中新增。</p>}
    {editing && <EntityFormModal spec={payeeForm(snap)} initial={editing.initial} isNew={editing.isNew}
      onClose={() => setEditing(null)} onSave={async (value) => {
        await store.runInAuditBatch(`保存平台资料“${value.name}”`, async (transactionStore) => {
          const latest = await transactionStore.payees.list({ includeDeleted: true });
          const found = matchingPayee(latest, editing.entry.name, editing.entry);
          if ((editing.isNew && found) || (found && found.id !== value.id)) throw new Error('该平台已添加，请关闭后重新打开编辑');
          if (latest.some((row) => row.id !== value.id && !row.isDeleted && normalizedPayeeName(row.name) === normalizedPayeeName(value.name))) throw new Error('已存在同名交易对象');
          await transactionStore.payees.put({ ...value, aliases: [...new Set([...(value.aliases ?? []), editing.entry.name, ...editing.entry.aliases])] });
        });
        bump();
      }} />}
  </section>;
}
