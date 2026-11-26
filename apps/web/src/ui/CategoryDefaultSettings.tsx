import { useEffect, useState } from 'react';
import { categoryOptions, type Category } from '@zichan/core';
import { recommendationCategories, timeMinutes, type CategoryDefaultPreferences } from '../category-defaults.js';
import { useCategoryDefaultPreferences, writeCategoryDefaultPreferences } from '../category-default-preferences.js';
import { CategoryPicker } from './EntityFormModal.js';
import { DateTimeInput } from './DateTimeInput.js';
import { useStore } from '../db/store.js';

export function CategoryDefaultSettings({ categories }: { categories: Category[] }) {
  const stored = useCategoryDefaultPreferences();
  const { preview } = useStore();
  const [draft, setDraft] = useState<CategoryDefaultPreferences>(stored);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(stored); }, [stored]);
  const options = recommendationCategories(categoryOptions(categories, 'expense', { leafOnly: true, includeHidden: true }));
  const change = (patch: Partial<CategoryDefaultPreferences>) => { setDraft((current) => ({ ...current, ...patch })); setSaved(false); setError(''); };
  const save = () => {
    const allowed = new Set(options.map((row) => row.value));
    if (!allowed.has(draft.fixedCategory)) { setError('请选择可用的默认支出分类。'); return; }
    if (draft.rules.some((row) => timeMinutes(row.from) === null || timeMinutes(row.to) === null || row.from === row.to || !allowed.has(row.category))) {
      setError('请为每个时段填写有效的起止时间和分类，开始与结束时间不能相同。'); return;
    }
    try { writeCategoryDefaultPreferences(draft); setError(''); setSaved(true); }
    catch { setError('本机设置未保存，请检查浏览器存储空间后重试。'); }
  };
  return <section className="zc-card" aria-label="智能预选分类">
    <h2 className="zc-section-title">智能预选分类</h2>
    <p className="zc-caption">打开记账就按时段和你的习惯选好分类，午间默认外卖。正常记账即可积累习惯；手选分类、模板和草稿会保留。本页设置仅在当前设备生效。</p>
    <fieldset disabled={!!preview} style={{ border: 0, padding: 0, margin: 0 }}>
      <label className="zc-label" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} /> 按时段和习惯预选分类</label>
      <div className="zc-field" style={{ marginTop: 16 }}>
        <label className="zc-label" htmlFor="default-expense-category">默认支出分类</label>
        <CategoryPicker fieldId="default-expense-category" name="defaultExpenseCategory" value={draft.fixedCategory} options={options} onChange={(value) => change({ fixedCategory: value })} />
        <p className="zc-meta">关闭智能预选时使用；开启后在没有匹配时段和习惯时使用。</p>
      </div>
      {draft.enabled && <div style={{ marginTop: 16 }}>
        <p className="zc-label">个人时段规则</p>
        <p className="zc-meta">优先于自动习惯。可跨午夜；重叠时按下方顺序使用第一条。</p>
        {draft.rules.map((row, index) => <div key={row.id} style={{ borderTop: '1px solid var(--border)', paddingBlock: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
            <DateTimeInput type="time" className="zc-input" style={{ width: 'auto', minWidth: 0, flex: '1 1 100px' }} aria-label={`规则 ${index + 1} 开始时间`} value={row.from} onChange={(value) => change({ rules: draft.rules.map((item) => item.id === row.id ? { ...item, from: value } : item) })} />
            <span>至</span>
            <DateTimeInput type="time" className="zc-input" style={{ width: 'auto', minWidth: 0, flex: '1 1 100px' }} aria-label={`规则 ${index + 1} 结束时间`} value={row.to} onChange={(value) => change({ rules: draft.rules.map((item) => item.id === row.id ? { ...item, to: value } : item) })} />
            <button type="button" className="zc-btn" aria-label={`删除规则 ${index + 1}`} onClick={() => change({ rules: draft.rules.filter((item) => item.id !== row.id) })}>删除</button>
          </div>
          <CategoryPicker fieldId={`category-rule-${row.id}`} name={`categoryRule-${row.id}`} ariaLabel={`规则 ${index + 1} 分类`} value={row.category} options={options} onChange={(value) => change({ rules: draft.rules.map((item) => item.id === row.id ? { ...item, category: value } : item) })} />
        </div>)}
        <button type="button" className="zc-btn" disabled={draft.rules.length >= 24} onClick={() => change({ rules: [...draft.rules, { id: crypto.randomUUID(), from: '11:00', to: '14:00', category: options.find((row) => row.value === 'takeaway')?.value ?? draft.fixedCategory }] })}>添加时段规则</button>
      </div>}
      <button type="button" className="zc-btn zc-btn--primary" style={{ marginTop: 16 }} onClick={save}>保存本机预选设置</button>
    </fieldset>
    {saved && <p role="status" className="zc-meta">已保存在本机</p>}
    {error && <p role="alert" className="zc-entry-field-error">{error}</p>}
  </section>;
}
