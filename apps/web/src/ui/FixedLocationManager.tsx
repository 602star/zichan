import { useState } from 'react';
import { fixedLocationContains, fixedLocationPath, newId, type FixedAsset, type FixedStorageLocation, type FixedWorkspacePreferences } from '@zichan/core';
import { archiveFixedLocation, updateFixedWorkspace } from '@zichan/db';
import { useStore } from '../db/store.js';
import { Card, CardAlert, CardEmpty } from './Card.js';
import { EntityFormModal, type EntityFormSpec } from './EntityFormModal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { MobilePageHeader } from './MobilePage.js';

export function FixedLocationManager({ preferences, assets, onBack }: { preferences: FixedWorkspacePreferences; assets: FixedAsset[]; onBack: () => void }) {
  const { store, bump } = useStore();
  const [editing, setEditing] = useState<FixedStorageLocation | 'new' | null>(null);
  const [archiving, setArchiving] = useState<FixedStorageLocation | null>(null);
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const active = preferences.locations.filter((row) => !row.archived);
  const spec: EntityFormSpec<FixedStorageLocation> = {
    title: '存放位置',
    fields: [{ key: 'name', label: '位置名称', type: 'text', required: true, placeholder: '例如卧室、衣柜、第一层' },
      { key: 'parentId', label: '上级位置', type: 'select', allowEmpty: true, options: active.filter((row) => editing === 'new' || !editing || !fixedLocationContains(preferences.locations, editing.id, row.id)).map((row) => ({ value: row.id, label: fixedLocationPath(preferences.locations, row.id) })) }],
    toValues: (location) => ({ name: location.name, parentId: location.parentId ?? '' }),
    fromValues: (value, previous) => ({ id: previous?.id ?? newId(), name: value.name?.trim() ?? '', parentId: value.parentId || undefined }),
    validate: (value) => value.name && value.name.length > 80 ? { name: '位置名称最多 80 个字符' } : undefined,
  };
  return <div className="zc-fixed-inventory">
    <MobilePageHeader title="管理存放位置" onBack={onBack} backLabel="返回物品" action={<button type="button" className="zc-btn zc-btn--primary" onClick={() => setEditing('new')}>新增位置</button>} />
    <p className="zc-caption">按“家 / 卧室 / 衣柜”组织；选择上级位置时包含其下级。改名会同步更新展示名称，移动物品保留记录。</p>
    {error && <CardAlert tone="danger">{error}</CardAlert>}
    <Card title="位置目录">
      {!active.length ? <><CardEmpty>还没有存放位置，可以先添加常用房间，再按需要细分。</CardEmpty><button type="button" className="zc-btn" onClick={async () => {
        setError('');
        try {
          await updateFixedWorkspace(store, (current) => {
            if (current.locations.some((row) => !row.archived)) throw new Error('目录已在其他窗口更新，请刷新后重试');
            const home = { id: newId(), name: '家' };
            return { ...current, locations: [...current.locations, home, ...['卧室', '厨房', '客厅', '书房', '储物间'].map((name) => ({ id: newId(), name, parentId: home.id }))] };
          }); bump();
        } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      }}>添加常用房间</button></> : active.sort((a, b) => fixedLocationPath(preferences.locations, a.id).localeCompare(fixedLocationPath(preferences.locations, b.id), 'zh-CN')).map((location) => <div className="zc-fixed-location-row" key={location.id}>
        <div><span>{fixedLocationPath(preferences.locations, location.id)}</span><small>{assets.filter((asset) => !asset.isDeleted && asset.role !== 'component' && fixedLocationContains(preferences.locations, location.id, asset.storageLocationId)).length} 件整件物品（含下级）</small></div>
        <div className="zc-fixed-actions"><button type="button" className="zc-btn" aria-label={`编辑位置 ${location.name}`} onClick={() => setEditing(location)}>编辑</button><button type="button" className="zc-btn" aria-label={`归档位置 ${location.name}`} onClick={() => { setTargetId(''); setArchiving(location); }}>归档并迁移</button></div>
      </div>)}
    </Card>
    {editing && <EntityFormModal spec={spec} initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSave={async (location) => {
      await updateFixedWorkspace(store, (current) => {
        const previous = current.locations.find((row) => row.id === location.id);
        if (editing !== 'new' && (!previous || previous.archived || previous.name !== editing.name || previous.parentId !== editing.parentId)) throw new Error('位置已在其他窗口变更，请关闭后重新打开');
        return { ...current, locations: previous ? current.locations.map((row) => row.id === location.id ? location : row) : [...current.locations, location] };
      }); bump();
    }} />}
    {archiving && <ConfirmDialog title="归档位置并迁移物品" confirmLabel="归档并迁移" onCancel={() => setArchiving(null)} onConfirm={async () => { await archiveFixedLocation(store, archiving.id, targetId || undefined); setArchiving(null); bump(); }}>
      <p>将归档“{fixedLocationPath(preferences.locations, archiving.id)}”及其下级位置，并迁移其中物品；保留位置变更记录。</p>
      <label className="zc-fixed-field">迁移到<select className="zc-select" aria-label="归档位置的迁移目标" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">未设置位置</option>{active.filter((row) => !fixedLocationContains(preferences.locations, archiving.id, row.id)).map((row) => <option key={row.id} value={row.id}>{fixedLocationPath(preferences.locations, row.id)}</option>)}</select></label>
    </ConfirmDialog>}
  </div>;
}
