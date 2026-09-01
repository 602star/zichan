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

export interface QuickExpenseCategoryOption {
  value: string;
  label: string;
}

export interface QuickExpenseDraft {
  amount: string;
  category: string;
  description?: string;
  date: string;
  time: string;
  assetId: string;
}

interface QuickExpenseModalProps {
  assets: Asset[];
  categories: QuickExpenseCategoryOption[];
  recentTransactions: Transaction[];
  templates: TransactionTemplate[];
  initialTemplate?: TransactionTemplate;
  defaultAssetId: string;
  onSave: (draft: QuickExpenseDraft) => Promise<void>;
  onClose: () => void;
}

const field: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 12,
  background: 'var(--surface)',
  color: 'var(--fg)',
  padding: '11px 13px',
  fontSize: 14,
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

export function QuickExpenseModal({
  assets,
  categories,
  recentTransactions,
  templates,
  initialTemplate,
  defaultAssetId,
  onSave,
  onClose,
}: QuickExpenseModalProps) {
  const titleId = useId();
  const amountRef = useRef<HTMLInputElement>(null);
  const fallbackCategory = useMemo(
    () => defaultQuickExpenseCategory(recentTransactions, categories),
    [categories, recentTransactions],
  );
  const initialValues = useRef<QuickExpenseDraft>({
    amount: initialTemplate?.amount ?? '',
    category: categories.some((option) => option.value === initialTemplate?.category)
      ? initialTemplate!.category
      : fallbackCategory,
    description: initialTemplate?.description ?? initialTemplate?.name ?? '',
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
            <h2 id={titleId} style={{ margin: 0, fontSize: 20 }}>记一笔支出</h2>
            <div style={{ marginTop: 5, color: 'var(--fg-subtle)', fontSize: 12 }}>只填金额即可保存，其他内容均有默认值。</div>
          </div>
          <button type="button" aria-label="关闭快速记账" onClick={requestClose} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--fg-muted)', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        {draftRestoredAt && (
          <div role="status" style={{ marginTop: 14, padding: '8px 10px', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--fg-muted)', fontSize: 12 }}>
            已恢复 {new Date(draftRestoredAt).toLocaleString()} 自动保存的支出草稿。
          </div>
        )}

        <label style={{ display: 'block', marginTop: 22 }}>
          <span style={{ display: 'block', marginBottom: 7, fontSize: 12, fontWeight: 800 }}>支出金额</span>
          <input
            ref={amountRef}
            data-dialog-initial-focus
            aria-label="支出金额"
            inputMode="decimal"
            value={amount}
            onChange={(event) => { touched.current = true; setAmount(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
            placeholder="0.00"
            style={{ ...field, fontSize: 32, fontWeight: 850, padding: '14px 16px' }}
          />
        </label>

        {expenseTemplates.length > 0 && (
          <div role="group" aria-label="常用支出" style={{ marginTop: 18 }}>
            <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 800 }}>常用支出</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {expenseTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  aria-pressed={category === template.category && description === (template.description ?? template.name)}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    background: category === template.category && description === (template.description ?? template.name) ? 'var(--accent-soft)' : 'var(--surface)',
                    color: category === template.category && description === (template.description ?? template.name) ? 'var(--accent)' : 'var(--fg-muted)',
                    padding: '8px 12px',
                    fontSize: 12,
                    fontWeight: 750,
                    cursor: 'pointer',
                  }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 18 }}>
          <label>
            <span style={{ display: 'block', marginBottom: 7, fontSize: 12, fontWeight: 800 }}>分类</span>
            <select aria-label="支出分类" value={category} onChange={(event) => { touched.current = true; setCategory(event.target.value); }} style={field}>
              {categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span style={{ display: 'block', marginBottom: 7, fontSize: 12, fontWeight: 800 }}>备注（可选）</span>
            <input aria-label="支出备注" value={description} onChange={(event) => { touched.current = true; setDescription(event.target.value); }} placeholder="例如：午餐" style={field} />
          </label>
        </div>

        <details style={{ marginTop: 16, color: 'var(--fg-muted)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 750 }}>更多信息</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
            <label><span style={{ display: 'block', marginBottom: 6, fontSize: 11 }}>日期</span><input aria-label="支出日期" type="date" value={date} onChange={(event) => { touched.current = true; setDate(event.target.value); }} style={field} /></label>
            <label><span style={{ display: 'block', marginBottom: 6, fontSize: 11 }}>时间</span><input aria-label="支出时间" type="time" value={time} onChange={(event) => { touched.current = true; setTime(event.target.value); }} style={field} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span style={{ display: 'block', marginBottom: 6, fontSize: 11 }}>币种</span><select aria-label="支出币种" value={assetId} onChange={(event) => { touched.current = true; setAssetId(event.target.value); }} style={field}>{activeAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.code}</option>)}</select></label>
          </div>
        </details>

        {error && <div role="alert" style={{ marginTop: 14, color: 'var(--negative)', fontSize: 12, fontWeight: 750 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button type="button" onClick={requestClose} disabled={busy} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', color: 'var(--fg-muted)', padding: '10px 16px', fontWeight: 750, cursor: 'pointer' }}>取消</button>
          <button type="button" onClick={() => void submit()} disabled={busy} style={{ border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--accent)', color: '#fff', padding: '10px 20px', fontWeight: 850, cursor: busy ? 'wait' : 'pointer' }}>{busy ? '保存中…' : '保存支出'}</button>
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
