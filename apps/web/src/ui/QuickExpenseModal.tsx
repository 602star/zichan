import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { D, type Asset, type Transaction, type TransactionTemplate } from '@zichan/core';
import {
  deleteFormDraft,
  formDraftFingerprint,
  formDraftKey,
  loadFormDraft,
  saveFormDraft,
} from '../db/form-drafts.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DialogShell } from './DialogShell.js';
import { CategoryPicker, type FieldOption } from './EntityFormModal.js';

export type QuickExpenseCategoryOption = FieldOption;

export interface QuickExpenseDraft {
  amount: string;
  category: string;
  description?: string;
  date: string;
  time: string;
  assetId: string;
}

export type QuickExpenseRecommendationSource = 'personal' | 'time' | 'recent' | 'fallback';

export interface QuickExpenseRecommendation {
  category: string;
  description?: string;
  label: string;
  reason: string;
  source: QuickExpenseRecommendationSource;
}

interface QuickExpenseModalProps {
  assets: Asset[];
  categories: QuickExpenseCategoryOption[];
  recentTransactions: Transaction[];
  templates: TransactionTemplate[];
  initialTemplate?: TransactionTemplate;
  defaultAssetId: string;
  categoryShowHiddenDefault?: boolean;
  onSave: (draft: QuickExpenseDraft) => Promise<void>;
  onClose: () => void;
}

const field: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  padding: '11px 13px',
  fontSize: 'var(--fs-body)',
};

const QUICK_EXPENSE_DRAFT_KEY = formDraftKey('quick-expense');

function draftValues(draft: QuickExpenseDraft): Record<string, string> {
  return {
    amount: draft.amount,
    category: draft.category,
    description: draft.description ?? '',
    date: draft.date,
    time: draft.time,
    assetId: draft.assetId,
  };
}

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

function minutesSinceMidnight(value: string | undefined): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(value ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localDayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const number = Date.UTC(year, month - 1, day) / 86_400_000;
  return Number.isFinite(number) ? number : null;
}

function isWeekendDate(value: string): boolean | null {
  const dayNumber = localDayNumber(value);
  if (dayNumber === null) return null;
  const day = new Date(dayNumber * 86_400_000).getUTCDay();
  return day === 0 || day === 6;
}

interface MealPeriod {
  label: '早餐' | '午餐' | '晚餐' | '夜宵';
  categoryIds: string[];
}

function mealPeriod(minutes: number): MealPeriod | null {
  if (minutes < 120 || minutes >= 1260) return { label: '夜宵', categoryIds: ['late_night_snack', 'food'] };
  if (minutes >= 300 && minutes < 600) return { label: '早餐', categoryIds: ['breakfast', 'food'] };
  if (minutes >= 630 && minutes < 870) return { label: '午餐', categoryIds: ['lunch_work_meal', 'food'] };
  if (minutes >= 1020 && minutes < 1260) return { label: '晚餐', categoryIds: ['dinner', 'food'] };
  return null;
}

function shortCategoryLabel(category: QuickExpenseCategoryOption | undefined): string {
  return category?.label.split(' / ').at(-1) ?? '待分类';
}

function personalizedCategory(
  transactions: readonly Pick<Transaction, 'type' | 'category' | 'date' | 'time' | 'isDeleted' | 'recordState'>[],
  allowedCategoryIds: ReadonlySet<string>,
  now: Date,
): { category: string; count: number } | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayNumber = localDayNumber(today)!;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const counts = new Map<string, number>();
  let total = 0;
  for (const transaction of transactions) {
    const transactionMinutes = minutesSinceMidnight(transaction.time);
    const transactionDay = localDayNumber(transaction.date);
    if (
      transaction.type !== 'expense'
      || transaction.isDeleted
      || transaction.recordState === 'voided'
      || !allowedCategoryIds.has(transaction.category)
      || transactionMinutes === null
      || transactionDay === null
      || transactionDay > todayNumber
      || todayNumber - transactionDay > 60
      || isWeekendDate(transaction.date) !== weekend
    ) continue;
    const distance = Math.abs(transactionMinutes - nowMinutes);
    if (Math.min(distance, 1440 - distance) > 90) continue;
    counts.set(transaction.category, (counts.get(transaction.category) ?? 0) + 1);
    total += 1;
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [top, second] = ranked;
  if (!top || top[1] < 3 || top[1] / total < 0.6 || top[1] === second?.[1]) return null;
  return { category: top[0], count: top[1] };
}

export function latestExpenseCategory(
  transactions: readonly Pick<Transaction, 'type' | 'category' | 'date' | 'time' | 'isDeleted' | 'recordState'>[],
  allowedCategoryIds: ReadonlySet<string>,
): string | undefined {
  return [...transactions]
    .filter((transaction) =>
      transaction.type === 'expense'
      && !transaction.isDeleted
      && transaction.recordState !== 'voided'
      && allowedCategoryIds.has(transaction.category))
    .sort((left, right) =>
      right.date.localeCompare(left.date)
      || (right.time ?? '').localeCompare(left.time ?? ''))[0]?.category;
}

export function defaultQuickExpenseCategory(
  transactions: readonly Pick<Transaction, 'type' | 'category' | 'date' | 'time' | 'isDeleted' | 'recordState'>[],
  categories: readonly QuickExpenseCategoryOption[],
): string {
  const allowed = new Set(categories.map((category) => category.value));
  return latestExpenseCategory(transactions, allowed)
    ?? (allowed.has('uncategorized') ? 'uncategorized' : categories[0]?.value ?? '');
}

export function quickExpenseRecommendationCategories(
  categories: readonly QuickExpenseCategoryOption[],
): QuickExpenseCategoryOption[] {
  return categories.filter((category) => !category.hidden && !category.catalogOnly);
}

export function recommendQuickExpense(
  transactions: readonly Pick<Transaction, 'type' | 'category' | 'date' | 'time' | 'isDeleted' | 'recordState'>[],
  categories: readonly QuickExpenseCategoryOption[],
  now = new Date(),
): QuickExpenseRecommendation {
  const allowed = new Set(categories.map((category) => category.value));
  const byId = new Map(categories.map((category) => [category.value, category]));
  const meal = mealPeriod(now.getHours() * 60 + now.getMinutes());
  const personal = personalizedCategory(transactions, allowed, now);
  if (personal) {
    const isMealCategory = meal?.categoryIds.includes(personal.category) || personal.category === 'food';
    return {
      category: personal.category,
      ...(isMealCategory && meal ? { description: meal.label } : {}),
      label: isMealCategory && meal ? meal.label : shortCategoryLabel(byId.get(personal.category)),
      reason: `根据近 60 天同时段的 ${personal.count} 笔记录`,
      source: 'personal',
    };
  }
  if (meal) {
    const category = meal.categoryIds.find((candidate) => allowed.has(candidate));
    if (category) {
      return {
        category,
        description: meal.label,
        label: meal.label,
        reason: `根据当前时间 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        source: 'time',
      };
    }
  }
  const recent = latestExpenseCategory(transactions, allowed);
  if (recent) {
    return {
      category: recent,
      label: shortCategoryLabel(byId.get(recent)),
      reason: '沿用最近一次有效支出分类',
      source: 'recent',
    };
  }
  const category = allowed.has('uncategorized') ? 'uncategorized' : categories[0]?.value ?? '';
  return {
    category,
    label: shortCategoryLabel(byId.get(category)),
    reason: '还没有足够的记账习惯，保存后会逐步学习',
    source: 'fallback',
  };
}

export function QuickExpenseModal({
  assets,
  categories,
  recentTransactions,
  templates,
  initialTemplate,
  defaultAssetId,
  categoryShowHiddenDefault = false,
  onSave,
  onClose,
}: QuickExpenseModalProps) {
  const titleId = useId();
  const amountRef = useRef<HTMLInputElement>(null);
  const recommendationCategories = useMemo(
    () => quickExpenseRecommendationCategories(categories),
    [categories],
  );
  const recommendation = useMemo(
    () => recommendQuickExpense(recentTransactions, recommendationCategories),
    [recentTransactions, recommendationCategories],
  );
  const initialValues = useRef<QuickExpenseDraft>({
    amount: initialTemplate?.amount ?? '',
    category: categories.some((option) => option.value === initialTemplate?.category)
      ? initialTemplate!.category
      : recommendation.category,
    description: initialTemplate?.description ?? initialTemplate?.name ?? recommendation.description ?? '',
    date: localDate(),
    time: localTime(),
    assetId: assets.some((asset) => !asset.isDeleted && asset.isActive && asset.id === initialTemplate?.assetId)
      ? initialTemplate!.assetId!
      : defaultAssetId,
  });
  const initialFingerprint = useRef(formDraftFingerprint(draftValues(initialValues.current), {}));
  const touched = useRef(false);
  const saved = useRef(false);
  const draftLoaded = useRef(false);
  const [amount, setAmount] = useState(initialValues.current.amount);
  const [category, setCategory] = useState(initialValues.current.category);
  const [description, setDescription] = useState(initialValues.current.description ?? '');
  const [date, setDate] = useState(initialValues.current.date);
  const [time, setTime] = useState(initialValues.current.time);
  const [assetId, setAssetId] = useState(initialValues.current.assetId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestoredAt, setDraftRestoredAt] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);

  const expenseTemplates = templates.filter((template) => template.type === 'expense' && !template.isDeleted && template.isActive);
  const activeAssets = assets.filter((asset) => !asset.isDeleted && asset.isActive);
  const currentDraft: QuickExpenseDraft = { amount, category, description, date, time, assetId };
  const currentValues = draftValues(currentDraft);
  const dirty = formDraftFingerprint(currentValues, {}) !== initialFingerprint.current;

  useEffect(() => {
    if (draftLoaded.current) return;
    let cancelled = false;
    void loadFormDraft(QUICK_EXPENSE_DRAFT_KEY)
      .then((draft) => {
        if (cancelled || !draft || touched.current) return;
        const allowedCategories = new Set(categories.map((option) => option.value));
        const allowedAssets = new Set(assets
          .filter((asset) => !asset.isDeleted && asset.isActive)
          .map((asset) => asset.id));
        const restored: QuickExpenseDraft = {
          amount: draft.values.amount ?? initialValues.current.amount,
          category: allowedCategories.has(draft.values.category ?? '')
            ? draft.values.category!
            : initialValues.current.category,
          description: draft.values.description ?? initialValues.current.description,
          date: draft.values.date || initialValues.current.date,
          time: draft.values.time || initialValues.current.time,
          assetId: allowedAssets.has(draft.values.assetId ?? '')
            ? draft.values.assetId!
            : initialValues.current.assetId,
        };
        if (initialTemplate) {
          if (initialTemplate.amount) restored.amount = initialTemplate.amount;
          if (allowedCategories.has(initialTemplate.category)) restored.category = initialTemplate.category;
          restored.description = initialTemplate.description ?? initialTemplate.name;
          if (initialTemplate.assetId && allowedAssets.has(initialTemplate.assetId)) restored.assetId = initialTemplate.assetId;
        }
        setAmount(restored.amount);
        setCategory(restored.category);
        setDescription(restored.description ?? '');
        setDate(restored.date);
        setTime(restored.time);
        setAssetId(restored.assetId);
        setDraftRestoredAt(draft.savedAt);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          draftLoaded.current = true;
          setDraftReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [assets, categories, initialTemplate]);

  useEffect(() => {
    if (!draftReady || !dirty || saved.current) return;
    const timer = window.setTimeout(() => {
      void saveFormDraft(QUICK_EXPENSE_DRAFT_KEY, currentValues, {}).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [currentValues, dirty, draftReady]);

  useEffect(() => {
    if (!dirty || saved.current) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function requestClose() {
    if (busy) return;
    if (dirty) setCloseOpen(true);
    else onClose();
  }

  function applyTemplate(template: TransactionTemplate) {
    touched.current = true;
    setCategory(template.category);
    setDescription(template.description ?? template.name);
    setAssetId(activeAssets.some((asset) => asset.id === template.assetId) ? template.assetId! : defaultAssetId);
    if (template.amount) setAmount(template.amount);
    amountRef.current?.focus();
  }

  function applyRecommendation() {
    touched.current = true;
    setCategory(recommendation.category);
    setDescription(recommendation.description ?? '');
    amountRef.current?.focus();
  }

  async function submit() {
    setError('');
    try {
      if (!D(amount || 0).gt(0)) {
        setError('请输入大于 0 的支出金额');
        amountRef.current?.focus();
        return;
      }
    } catch {
      setError('请输入有效的支出金额');
      amountRef.current?.focus();
      return;
    }
    if (!category) {
      setError('请选择支出分类');
      return;
    }
    setBusy(true);
    try {
      await onSave({ amount, category, description: description.trim() || undefined, date, time, assetId });
      saved.current = true;
      await deleteFormDraft(QUICK_EXPENSE_DRAFT_KEY).catch(() => undefined);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={requestClose}
      dismissDisabled={busy}
      initialFocusRef={amountRef}
      panelClassName="zc-quick-expense-dialog"
      panelStyle={{ width: 'min(560px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflow: 'auto' }}
    >
      <div style={{ padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2 id={titleId} style={{ margin: 0, fontSize: 'var(--fs-heading)' }}>记一笔支出</h2>
            <div style={{ marginTop: 5, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>只填金额即可保存，其他内容均有默认值。</div>
          </div>
          <button type="button" aria-label="关闭快速记账" onClick={requestClose} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--fs-heading)', cursor: 'pointer' }}>×</button>
        </div>

        {!initialTemplate && recommendation.category && (
          <div data-testid="quick-expense-recommendation" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--accent-soft)', color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>
            <span>
              <b style={{ color: 'var(--accent)' }}>{category === recommendation.category && description === (recommendation.description ?? '') ? '已推荐' : '推荐'}：{recommendation.label}</b>
              <span style={{ marginLeft: 7 }}>{recommendation.reason}</span>
            </span>
            {(category !== recommendation.category || description !== (recommendation.description ?? '')) && (
              <button type="button" onClick={applyRecommendation} style={{ flex: '0 0 auto', border: '1px solid var(--accent)', borderRadius: 'var(--r-pill)', background: 'var(--surface)', color: 'var(--accent)', padding: '5px 9px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>使用推荐</button>
            )}
          </div>
        )}

        {draftRestoredAt && (
          <div role="status" style={{ marginTop: 14, padding: '8px 10px', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>
            已恢复 {new Date(draftRestoredAt).toLocaleString()} 自动保存的支出草稿。
          </div>
        )}

        <label style={{ display: 'block', marginTop: 22 }}>
          <span style={{ display: 'block', marginBottom: 7, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>支出金额</span>
          <input
            ref={amountRef}
            data-dialog-initial-focus
            aria-label="支出金额"
            inputMode="decimal"
            value={amount}
            onChange={(event) => { touched.current = true; setAmount(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
            placeholder="0.00"
            style={{ ...field, fontSize: 'var(--fs-hero)', fontWeight: 'var(--fw-bold)', padding: '14px 16px' }}
          />
        </label>

        {expenseTemplates.length > 0 && (
          <div role="group" aria-label="常用支出" style={{ marginTop: 18 }}>
            <div style={{ marginBottom: 8, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>常用支出</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {expenseTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  aria-pressed={category === template.category && description === (template.description ?? template.name)}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-pill)',
                    background: category === template.category && description === (template.description ?? template.name) ? 'var(--accent-soft)' : 'var(--surface)',
                    color: category === template.category && description === (template.description ?? template.name) ? 'var(--accent)' : 'var(--fg-muted)',
                    padding: '8px 12px',
                    fontSize: 'var(--fs-caption)',
                    fontWeight: 'var(--fw-bold)',
                    cursor: 'pointer',
                  }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="zc-quick-expense-main" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 18 }}>
          <div>
            <label htmlFor="quick-expense-category" style={{ display: 'block', marginBottom: 7, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>分类</label>
            <CategoryPicker
              fieldId="quick-expense-category"
              name="category"
              value={category}
              options={categories}
              defaultShowHidden={categoryShowHiddenDefault}
              onChange={(value) => {
                touched.current = true;
                setCategory(value);
              }}
            />
          </div>
          <label>
            <span style={{ display: 'block', marginBottom: 7, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>备注（可选）</span>
            <input aria-label="支出备注" value={description} onChange={(event) => { touched.current = true; setDescription(event.target.value); }} placeholder="例如：午餐" style={field} />
          </label>
        </div>

        <details style={{ marginTop: 16, color: 'var(--text-secondary)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>更多信息</summary>
          <div className="zc-quick-expense-split" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
            <label><span style={{ display: 'block', marginBottom: 6, fontSize: 'var(--fs-meta)' }}>日期</span><input aria-label="支出日期" type="date" value={date} onChange={(event) => { touched.current = true; setDate(event.target.value); }} style={field} /></label>
            <label><span style={{ display: 'block', marginBottom: 6, fontSize: 'var(--fs-meta)' }}>时间</span><input aria-label="支出时间" type="time" value={time} onChange={(event) => { touched.current = true; setTime(event.target.value); }} style={field} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span style={{ display: 'block', marginBottom: 6, fontSize: 'var(--fs-meta)' }}>币种</span><select aria-label="支出币种" value={assetId} onChange={(event) => { touched.current = true; setAssetId(event.target.value); }} style={field}>{activeAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.code}</option>)}</select></label>
          </div>
        </details>

        {error && <div role="alert" style={{ marginTop: 14, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button type="button" onClick={requestClose} disabled={busy} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', color: 'var(--text-secondary)', padding: '10px 16px', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>取消</button>
          <button type="button" onClick={() => void submit()} disabled={busy} style={{ border: '1px solid var(--accent)', borderRadius: 'var(--r-sm)', background: 'var(--accent)', color: '#fff', padding: '10px 20px', fontWeight: 'var(--fw-bold)', cursor: busy ? 'wait' : 'pointer' }}>{busy ? '保存中…' : '保存支出'}</button>
        </div>
        {closeOpen && (
          <ConfirmDialog
            title="关闭未保存支出"
            confirmLabel="保留草稿并关闭"
            cancelLabel="继续编辑"
            onCancel={() => setCloseOpen(false)}
            onConfirm={async () => {
              await saveFormDraft(QUICK_EXPENSE_DRAFT_KEY, currentValues, {});
              onClose();
            }}
          >
            当前支出还没有保存。关闭后会保留自动草稿，下次打开时可以继续填写。
          </ConfirmDialog>
        )}
      </div>
    </DialogShell>
  );
}
