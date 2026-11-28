import { readRestoreEntryDraft } from '../draft-preferences.js';
import { LedgerAttachmentField } from './LedgerAttachmentField.js';
import { changedCaptureFields } from '../order-capture/attachment-review.js';
import type { AttachmentApplication } from './AttachmentProcessing.js';
import { assertReviewedRedactedImage } from '../order-capture/redaction.js';
import { X } from 'lucide-react';
import { DuplicateMasterDataError } from '@zichan/db';
import { scheduleDuplicateWarning } from '../master-data-saving.js';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { newId } from '@zichan/core';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DateTimeInput } from './DateTimeInput.js';
import { formTaskGroups } from './form-task-groups.js';
import { WorkspaceDialog } from './WorkspaceDialog.js';
import { FormDraftStatus, useFormDraftAutosave } from './FormDraftStatus.js';
import { type AttachmentDraftData } from '../db/attachment-storage.js';
import { loadAttachmentContent } from '../attachment-content.js';
import { useStore } from '../db/store.js';
import { useCompactView } from './useCompactView.js';
import { useCategoryDefault } from '../use-category-default.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { currentDevicePosition, scanBarcode } from '../device-capabilities.js';
import { ensureAssetPreset, type AssetPresetCode } from '../assetPresets.js';
import { sanitizeNumericInput } from '../form-number.js';
import {
  type FormDraft,
  deleteFormDraft,
  formDraftFingerprint,
  formDraftKey,
  loadFormDraft,
  listFormDrafts,
  saveFormDraft,
} from '../db/form-drafts.js';
import {
  emptyOptionHint,
  moreFieldsSummaryLabel,
  progressiveFieldGroups,
  isFieldVisible,
  isMoreFieldVisible,
  requiredFieldErrors,
  unreachableErrorKeys,
} from '../form-validation.js';
import { CategoryPicker, splitCategoryLabel, type FieldOption } from './CategoryPicker.js';
import { AttachmentSaveButton, FormField, type FieldDef, type FieldType } from './EntityFormFields.js';

export { CategoryPicker, splitCategoryLabel };
export type { FieldDef, FieldOption, FieldType };

export interface EntityFormSpec<T> {
  title: string;
  identityKind?: 'game_account' | 'game_season' | 'payee' | 'transaction_tag' | 'scheduled_transaction';
  /** Stable namespace for auto-saved drafts. Defaults to the form title. */
  draftKey?: string;
  modalWidth?: number;
  moreInitiallyOpen?: boolean;
  progressiveFields?: boolean;
  /** Optional fields that move behind “更多信息” on a narrow screen when creating. */
  compactNewFieldKeys?: string[];
  /** Keep date and time visible together at the front of a phone transaction form. */
  compactDateTime?: boolean;
  confirmNewDraft?: boolean;
  expenseCategoryDefaults?: boolean;
  localOrderCapture?: boolean;
  privacyAttachments?: boolean;
  refreshDefaults?: (values: Record<string, string>, manual: ReadonlySet<string>) => Record<string, string>;
  summary?: (values: Record<string, string>) => string | undefined;
  optionalFieldOptions?: { key: string; label: string }[];
  onFieldChange?: (values: Record<string, string>, key: string, manual: ReadonlySet<string>) => Record<string, string>;
  fields: FieldDef[];
  /** existing entity → string form values */
  toValues: (entity: T) => Record<string, string>;
  /** form values → entity (preserving id/createdAt when editing) */
  fromValues: (values: Record<string, string>, existing?: T, files?: Record<string, AttachmentDraftData[]>) => T;
  validate?: (values: Record<string, string>, existing?: T) => Record<string, string> | string | undefined;
}

function defaults<T>(spec: EntityFormSpec<T>): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of spec.fields) {
    const options = fieldOptions(f, v);
    if (f.defaultValue !== undefined) v[f.key] = f.defaultValue;
    else if (f.type === 'checkbox') v[f.key] = 'false';
    else if (f.type === 'select' || f.type === 'category') v[f.key] = f.allowEmpty ? '' : (options[0]?.value ?? '');
    else if (f.type === 'multiselect' || f.type === 'allocation' || f.type === 'file') v[f.key] = '';
    else v[f.key] = '';
  }
  return v;
}

function fieldOptions(f: FieldDef, values: Record<string, string>): FieldOption[] {
  return typeof f.options === 'function' ? f.options(values) : f.options ?? [];
}

/** First focusable control inside a rendered form field, used to jump at a blocking field. */
function focusTarget(fieldId: string): HTMLElement | null {
  const selector = typeof CSS !== 'undefined' && CSS.escape
    ? `[data-form-field="${CSS.escape(fieldId)}"] input:not([type="hidden"]), [data-form-field="${CSS.escape(fieldId)}"] select, [data-form-field="${CSS.escape(fieldId)}"] textarea, [data-form-field="${CSS.escape(fieldId)}"] button[aria-haspopup]`
    : '';
  if (selector) {
    const found = document.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return document.getElementById(fieldId);
}

/** Domain validation errors carry the rejected field name; map it back when it is a form field. */
function rejectedFieldKey(error: unknown, fields: FieldDef[]): string | undefined {
  const field = (error as { field?: unknown } | null | undefined)?.field;
  if (typeof field !== 'string' || !field) return undefined;
  return fields.some((f) => f.key === field) ? field : undefined;
}

const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
type FileRow = AttachmentDraftData;

let fileLimitCache: { expiresAt: number; bytes: number } | undefined;

async function attachmentFileLimit(): Promise<number> {
  if (fileLimitCache && fileLimitCache.expiresAt > Date.now()) return fileLimitCache.bytes;
  const connections = loadSyncConnections().filter((connection) => connection.enabled);
  const urls = [...new Set(connections.length ? connections.flatMap((connection) => {
    try { return [buildSyncBaseUrl(connection)]; } catch { return []; }
  }) : [window.location.origin])];
  const limits = await Promise.all(urls.map(async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!response.ok) return undefined;
      const body = await response.json() as { serverId?: string; attachmentMaxFileBytes?: number };
      const expected = connections.find((connection) => buildSyncBaseUrl(connection) === baseUrl)?.serverId;
      if (expected && body.serverId !== expected) return undefined;
      const bytes = body.attachmentMaxFileBytes;
      return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 1024 ** 2 && bytes <= 1024 ** 3 ? bytes : undefined;
    } catch { return undefined; }
  }));
  const known = limits.filter((value): value is number => value !== undefined);
  const bytes = known.length ? Math.min(...known, ...(limits.some((value) => value === undefined) ? [MAX_ATTACHMENT_BYTES] : [])) : MAX_ATTACHMENT_BYTES;
  fileLimitCache = { expiresAt: Date.now() + 30_000, bytes };
  return bytes;
}

function serializableFile(row: FileRow): Omit<FileRow, 'contentBlob' | 'thumbnailBlob'> {
  const { contentBlob: _content, thumbnailBlob: _thumbnail, ...metadata } = row;
  return metadata;
}

async function prepareFile(file: File, maxBytes: number): Promise<FileRow> {
  if (file.size > maxBytes) throw new Error(`${file.name} 超过 ${(maxBytes / 1024 ** 2).toLocaleString()} MiB 限制`);
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    return { fileName: file.name, contentBlob: file, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumbnail = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
    return {
      fileName: file.name,
      contentBlob: file,
      thumbnailBlob: thumbnail ?? undefined,
      mimeType: file.type || 'image/jpeg',
      sizeBytes: file.size,
    };
  } catch {
    return { fileName: file.name, contentBlob: file, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size };
  }
}

function normalizeValues(fields: FieldDef[], values: Record<string, string>, changedKey?: string): Record<string, string> {
  let next = values;
  for (const f of fields) {
    if (f.type !== 'select' && f.type !== 'category' && f.type !== 'multiselect') continue;
    const options = fieldOptions(f, next);
    const optionValues = new Set([
      ...options.map((o) => o.value),
      ...(f.type === 'category' && f.allowParentSelection
        ? options.map((o) => o.parentId).filter((id): id is string => Boolean(id))
        : []),
    ]);
    const current = next[f.key] ?? '';
    if (f.type === 'select' || f.type === 'category') {
      const shouldReset = (current && !optionValues.has(current)) || (!!changedKey && !!f.resetWhen?.includes(changedKey));
      const shouldDefault = !current && !f.allowEmpty && options.length > 0;
      if ((shouldReset || shouldDefault) && f.key !== changedKey) {
        next = { ...next, [f.key]: f.allowEmpty ? '' : options[0]?.value ?? '' };
      }
    } else if (current) {
      const kept = current.split(',').map((x) => x.trim()).filter((x) => optionValues.has(x));
      if (kept.join(',') !== current) next = { ...next, [f.key]: kept.join(',') };
    }
  }
  return next;
}

export async function persistDraftBeforeClose(
  persist: () => Promise<unknown>,
  close: () => void,
): Promise<void> {
  await persist();
  close();
}

export function EntityFormModal<T>({ spec, initial, isNew, onSave, onDelete, deleteLabel = '删除', onClose, optionalFieldKeys, workspace = 'page', initialFieldValues, onSaveContinue, retainEntryFields, onRetainEntryFieldsChange }: {
  spec: EntityFormSpec<T>;
  initial?: T;
  /** Treat a prefilled entity as a new record rather than an existing record being edited. */
  isNew?: boolean;
  onSave: (entity: T) => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  deleteLabel?: string;
  onClose: () => void;
  optionalFieldKeys?: string[];
  workspace?: 'page' | 'composer' | false;
  initialFieldValues?: Record<string, string>;
  onSaveContinue?: (values: Record<string, string>) => void;
  retainEntryFields?: boolean;
  onRetainEntryFieldsChange?: (retain: boolean) => void;
}) {
  const compactView = useCompactView();
  const { store, bump, preview } = useStore();
  const [duplicates, setDuplicates] = useState<DuplicateMasterDataError | null>(null);
  const [existingChoice, setExistingChoice] = useState<T | undefined>();
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const formId = useId().replace(/:/g, '');
  const titleId = `${formId}-title`;
  const initialValues = useMemo(
    () => ({ ...(initial ? { ...defaults(spec), ...spec.toValues(initial) } : defaults(spec)), ...initialFieldValues }),
    [initial, spec, initialFieldValues],
  );
  const initialFiles = useMemo<Record<string, FileRow[]>>(() => ({}), []);
  const entity = initial && typeof initial === 'object' ? initial as { id?: unknown; version?: unknown } : undefined;
  const entityVersion = typeof entity?.version === 'number' ? entity.version : undefined;
  const baseDraftKey = formDraftKey(spec.draftKey ?? spec.title, entity);
  const separateDrafts = !!spec.compactDateTime && !!spec.confirmNewDraft && (isNew ?? !initial);
  const [draftKey, setDraftKey] = useState(() => separateDrafts ? `${baseDraftKey}:session:${newId()}` : baseDraftKey);
  const [availableDrafts, setAvailableDrafts] = useState<FormDraft[]>([]);
  const initialFingerprint = useRef(formDraftFingerprint(initialValues, initialFiles));
  const touched = useRef(false);
  const manualFields = useRef(new Set([
    ...(initial ? Object.keys(spec.toValues(initial)).filter((key) => !!spec.toValues(initial)[key]) : []),
    ...Object.keys(initialFieldValues ?? {}).filter((key) => !!initialFieldValues?.[key]),
  ]));
  const [prefilledValues, setPrefilledValues] = useState(initial ? initialValues : {});
  const savedOrDeleted = useRef(false);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const focusAttempts = useRef(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [fullFields, setFullFields] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState('');
  const [fileValues, setFileValues] = useState<Record<string, FileRow[]>>(initialFiles);
  const [attachmentProcessing, setAttachmentProcessing] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const draftHandled = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<FormDraft | null>(null);
  const [draftRestoredAt, setDraftRestoredAt] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const createdAssetOptions = useRef<Record<string, FieldOption[]>>({});
  const [, setCreatedAssetRevision] = useState(0);
  const creating = isNew ?? !initial;
  const categoryField = spec.fields.find((field) => field.key === 'category');
  const contextualDefault = useCategoryDefault(values.date ?? '', values.time ?? '', categoryField ? fieldOptions(categoryField, values) : [],
    !!spec.expenseCategoryDefaults && !initial && creating && values.type === 'expense' && !manualFields.current.has('category'));
  const showContextReason = spec.expenseCategoryDefaults && !initial && !pendingDraft && values.type === 'expense'
    && !manualFields.current.has('category') && contextualDefault.category === values.category;

  const fingerprint = formDraftFingerprint(values, fileValues);
  const dirty = fingerprint !== initialFingerprint.current;
  const draftAutosave = useFormDraftAutosave(
    draftReady && !pendingDraft && dirty && !savedOrDeleted.current,
    fingerprint,
    () => saveFormDraft(draftKey, values, fileValues, entityVersion, [...manualFields.current]),
  );

  useEffect(() => {
    let cancelled = false;
    if (draftHandled.current) return;
    void (separateDrafts ? listFormDrafts(baseDraftKey).then((drafts) => { if (!cancelled) setAvailableDrafts(drafts); return readRestoreEntryDraft() ? drafts[0] ?? null : null; }) : loadFormDraft(draftKey, entityVersion))
      .then(async (draft) => {
        if (cancelled) return;
        draftHandled.current = true;
        setDraftReady(true);
        if (!draft || touched.current) return;
        if (creating && spec.confirmNewDraft && !separateDrafts) { setPendingDraft(draft); return; }
        if (separateDrafts) setDraftKey(draft.key);
        manualFields.current = new Set(draft.manualFieldKeys ?? Object.keys(draft.values).filter((key) => draft.values[key] !== initialValues[key]));
        if (spec.expenseCategoryDefaults && draft.values.category) manualFields.current.add('category');
        let restored = { ...initialValues, ...draft.values };
        if (!initial && draft.manualFieldKeys && spec.refreshDefaults) restored = spec.refreshDefaults(restored, manualFields.current);
        restored = normalizeValues(spec.fields, restored);
        setValues(restored);
        setPrefilledValues(restored);
        setFileValues(Object.fromEntries(Object.entries(draft.files ?? {}).map(([key, rows]) => [key, rows.map((row) => ({ ...row, id: row.id ?? newId() }))])));
        setDraftRestoredAt(draft.savedAt);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [draftKey, baseDraftKey, separateDrafts, entityVersion, initialValues, initial, spec, creating]);

  useEffect(() => {
    if (pendingDraft || !dirty || savedOrDeleted.current) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, pendingDraft]);

  const fieldVersions = useRef<Record<string, number>>({});
  const set = (key: string, value: string) => {
    fieldVersions.current[key] = (fieldVersions.current[key] ?? 0) + 1;
    touched.current = true;
    manualFields.current.add(key);
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setErr((prev) => (prev ? null : prev));
    setValues((v) => {
      const next = { ...v, [key]: value };
      const fields = spec.fields.map((field) => field.assetPresetOptions
        ? { ...field, options: (current: Record<string, string>) => optionsWithCreatedAssets(field, current) }
        : field);
      return normalizeValues(fields, spec.onFieldChange?.(next, key, manualFields.current) ?? next, key);
    });
  };
  const optionsWithCreatedAssets = (field: FieldDef, current: Record<string, string>): FieldOption[] => {
    const options = fieldOptions(field, current);
    const existing = new Set(options.map((option) => option.value));
    return [...options, ...(createdAssetOptions.current[field.key] ?? []).filter((option) => !existing.has(option.value))];
  };
  const addAssetPreset = async (fieldKey: string, code: AssetPresetCode) => {
    const { asset } = await ensureAssetPreset(store, code);
    const prior = createdAssetOptions.current[fieldKey] ?? [];
    createdAssetOptions.current[fieldKey] = [...prior.filter((option) => option.value !== asset.id), { value: asset.id, label: asset.code }];
    setCreatedAssetRevision((revision) => revision + 1);
    set(fieldKey, asset.id);
    bump();
  };
  const requestClose = () => {
    if (busy || iconBusy) return;
    if (pendingDraft) { onClose(); return; }
    if (dirty) setCloseOpen(true);
    else onClose();
  };
  const allMoreFields = spec.fields.filter((f) => f.section === 'more' && !f.hidden);
  const allMoreFieldKeys = allMoreFields.map((f) => f.key);
  const compactKeys = useMemo(
    () => compactView && (!initial || isNew) ? spec.compactNewFieldKeys ?? [] : [],
    [compactView, initial, isNew, spec.compactNewFieldKeys],
  );
  const groups = spec.progressiveFields ? progressiveFieldGroups(spec.fields, values, prefilledValues, optionalFieldKeys ?? [], compactKeys) : undefined;
  const compactEntry = compactView && !!spec.compactDateTime;
  const compactDateFields = compactEntry ? spec.fields.filter((f) => (f.key === 'date' || f.key === 'time') && isFieldVisible(f, values)) : [];
  const inCompactDateRow = (field: FieldDef) => compactDateFields.some((f) => f.key === field.key);
  const moreFields = (spec.progressiveFields ? fullFields ? [] : groups?.more ?? [] : allMoreFields.filter((f) => isFieldVisible(f, values))).filter((f) => !inCompactDateRow(f));
  const coreFields = (spec.progressiveFields && fullFields ? spec.fields.filter((f) => isFieldVisible(f, values)) : groups?.core ?? spec.fields.filter((f) => f.section !== 'more' && isFieldVisible(f, values))).filter((f) => !inCompactDateRow(f));
  const coreGroups = spec.compactDateTime ? [
    { title: '', kind: 'context', fields: ['type', 'accountId'].flatMap((key) => coreFields.filter((field) => field.key === key)) },
    { title: '', kind: 'primary', fields: ['amount', 'category'].flatMap((key) => coreFields.filter((field) => field.key === key)) },
    { title: '', kind: 'details', fields: coreFields.filter((field) => !['type', 'accountId', 'amount', 'category'].includes(field.key)) },
  ].filter((group) => group.fields.length > 0) : (compactView && !spec.progressiveFields && coreFields.length > 6
    ? formTaskGroups(coreFields, /日常|退款/.test(spec.title)) : [{ title: '', fields: coreFields }]).map((group) => ({ ...group, kind: 'standard' }));
  const visibleMoreFields = groups ? moreFields : moreFields.filter((f) => isMoreFieldVisible(f, values, optionalFieldKeys, allMoreFieldKeys));
  const moreExpanded = moreOpen ?? spec.moreInitiallyOpen ?? visibleMoreFields.length > 0;
  /** Reveal a blocking field without changing the selected field mode. */
  const revealField = async (key: string) => {
    const field = spec.fields.find((f) => f.key === key);
    if (!field || !isFieldVisible(field, values)) return;
    if (spec.progressiveFields) { if (!coreFields.some((f) => f.key === key) && !inCompactDateRow(field)) setMoreOpen(true); return; }
    if (field.section !== 'more' && !compactKeys.includes(key)) return;
    setMoreOpen(true);
  };
  /** Scroll and focus a field once it is on screen; retries across a few renders. */
  const queueFocus = (key: string) => {
    focusAttempts.current = 0;
    setPendingFocus(key);
  };
  const supportsContinue = !!onSaveContinue;
  const amountFirst = spec.fields[0]?.key === 'amount';
  useEffect(() => {
    if ((workspace === 'composer' || supportsContinue || amountFirst) && creating && !compactView && draftReady && !pendingDraft && !touched.current) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      focusAttempts.current = 0;
      setPendingFocus('amount');
    }
  }, [workspace, supportsContinue, amountFirst, creating, compactView, draftReady, pendingDraft]);
  useEffect(() => {
    if (!pendingFocus) return;
    const field = spec.fields.find((f) => f.key === pendingFocus);
    if (field && !isFieldVisible(field, values)) {
      setPendingFocus(null);
      return;
    }
    const node = focusTarget(`${formId}-${pendingFocus}`);
    if ((field?.section === 'more' || compactKeys.includes(pendingFocus)) && !fullFields && !moreExpanded) { setMoreOpen(true); return; }
    if (!node) {
      if (focusAttempts.current < 4) {
        focusAttempts.current += 1;
        const timer = window.setTimeout(() => setPendingFocus(pendingFocus), 40);
        return () => window.clearTimeout(timer);
      }
      setPendingFocus(null);
      return;
    }
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    node.focus?.({ preventScroll: true });
    setPendingFocus(null);
    return undefined;
  }, [pendingFocus, formId, spec.fields, values, compactKeys, fullFields, moreExpanded]);
  /** Required pickers with nothing to pick yet explain themselves up front. */
  const optionHint = (field: FieldDef, optionCount: number) => {
    if (field.type !== 'select' && field.type !== 'category' && field.type !== 'multiselect') return undefined;
    if (!isFieldVisible(field, values)) return undefined;
    return emptyOptionHint(field, optionCount);
  };
  const selectedValues = (key: string) => (values[key] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const fileRows = (key: string): FileRow[] => {
    if (fileValues[key]) return fileValues[key]!;
    try {
      const parsed = JSON.parse(values[key] || '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') as FileRow[] : [];
    } catch {
      return [];
    }
  };
  async function readFiles(key: string, files: FileList | null) {
    if (!files?.length) return;
    const current = fileRows(key);
    if (current.length + files.length > MAX_ATTACHMENT_COUNT) {
      setErr(`每条记录最多添加 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    try {
      const estimate = await navigator.storage?.estimate();
      const incomingBytes = [...files].reduce((sum, file) => sum + file.size, 0);
      if (estimate?.quota && (estimate.usage ?? 0) + incomingBytes * 2 > estimate.quota * 0.9) {
        throw new Error('剩余本地存储空间不足，请先导出备份或减少附件大小');
      }
      const maxBytes = await attachmentFileLimit();
      const next = await Promise.all([...files].map(async (file) => ({ ...await prepareFile(file, maxBytes), id: newId() })));
      const combined = [...current, ...next];
      touched.current = true;
      setFileValues((rows) => ({ ...rows, [key]: combined }));
      set(key, JSON.stringify(combined.map(serializableFile)));
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  }
  const captureLive = useRef({ values, fileValues }); captureLive.current = { values, fileValues };
  async function restoreAvailableDraft(draft: FormDraft) {
    if (busy || attachmentProcessing) return;
    setBusy(true); setErr(null);
    const snapshot = captureLive.current;
    try {
      await draftAutosave.drainPending();
      if (captureLive.current.values !== snapshot.values || captureLive.current.fileValues !== snapshot.fileValues) throw new Error('当前输入已变化，请重新选择草稿。');
      if (dirty) {
        const saved = await saveFormDraft(draftKey, snapshot.values, snapshot.fileValues, entityVersion, [...manualFields.current]);
        setAvailableDrafts((rows) => [saved, ...rows.filter((row) => row.key !== saved.key)]);
      }
      if (captureLive.current.values !== snapshot.values || captureLive.current.fileValues !== snapshot.fileValues) throw new Error('当前输入已变化，请重新选择草稿。');
      manualFields.current = new Set(draft.manualFieldKeys ?? Object.keys(draft.values));
      if (spec.expenseCategoryDefaults && draft.values.category) manualFields.current.add('category');
      let restored = { ...initialValues, ...draft.values };
      if (!initial && draft.manualFieldKeys && spec.refreshDefaults) restored = spec.refreshDefaults(restored, manualFields.current);
      setDraftKey(draft.key); setValues(normalizeValues(spec.fields, restored)); setPrefilledValues(restored);
      setFileValues(Object.fromEntries(Object.entries(draft.files).map(([key, rows]) => [key, rows.map((row) => ({ ...row, id: row.id ?? newId() }))])));
      setDraftRestoredAt(draft.savedAt); touched.current = true;
    } catch (cause) { setErr(cause instanceof Error ? cause.message : '恢复草稿失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function applyAttachment(id: string, application: AttachmentApplication) {
    const current = captureLive.current;
    const rows = current.fileValues.attachmentDrafts ?? fileRows('attachmentDrafts');
    const existing = rows.find((row) => row.id === id);
    if (!existing) throw new Error('附件已移除或替换，请重新提取。');
    if (changedCaptureFields(application.baseline, current.values, application.fields, application.baselineVersions, fieldVersions.current).length) throw new Error('表单内容已变化，请重新核对。');
    if (application.retention === 'redacted') {
      if (!application.attachment) throw new Error('脱敏图片尚未生成。');
      await assertReviewedRedactedImage(application.attachment);
      if (application.attachment.contentBlob.size > await attachmentFileLimit()) throw new Error('脱敏附件超过服务器限制，请裁剪后重试。');
    }
    const latest = captureLive.current;
    if (changedCaptureFields(application.baseline, latest.values, application.fields, application.baselineVersions, fieldVersions.current).length) throw new Error('表单内容已变化，请重新核对。');
    const liveRows = latest.fileValues.attachmentDrafts ?? rows;
    if (!liveRows.includes(existing)) throw new Error('附件已变化，请重新处理。');
    const nextRows = application.retention === 'none' ? liveRows.filter((row) => row.id !== id) : liveRows.map((row) => row.id !== id ? row : application.retention === 'redacted' ? { ...application.attachment!, id, note: `附件处理：打码 ${application.attachment!.privacyReview.maskCount ?? 0} 处` } : { ...row, note: row.mimeType === 'application/pdf' ? '附件处理：保留原始 PDF' : '附件处理：保留原图' });
    const nextManual = new Set([...manualFields.current, ...Object.keys(application.fields)]);
    let nextValues: Record<string, string> = { ...latest.values, ...application.fields, ...(application.fields.merchant ? { payeeId: '' } : {}), attachmentDrafts: JSON.stringify(nextRows.map(serializableFile)) };
    for (const key of Object.keys(application.fields)) nextValues = spec.onFieldChange?.(nextValues, key, nextManual) ?? nextValues;
    const normalized = normalizeValues(spec.fields, nextValues);
    touched.current = true;
    for (const key of Object.keys(application.fields)) { manualFields.current.add(key); fieldVersions.current[key] = (fieldVersions.current[key] ?? 0) + 1; }
    setFileValues((files) => ({ ...files, attachmentDrafts: nextRows }));
    setValues(normalized);
  }

  async function runDeviceAction(field: FieldDef) {
    if (!field.deviceAction || deviceBusy) return;
    setDeviceBusy(field.key);
    setErr(null);
    try {
      if (field.deviceAction === 'scan-barcode') {
        const result = await scanBarcode();
        set(field.key, result.content);
        return;
      }
      const position = await currentDevicePosition();
      const nameKey = field.type === 'location' ? 'locationName' : field.key;
      touched.current = true;
      manualFields.current.add(nameKey);
      setValues((current) => normalizeValues(spec.fields, {
        ...current,
        ...(field.type === 'location' ? { [field.key]: '' } : {}),
        [nameKey]: current[nameKey]?.trim() || '当前位置',
        latitude: position.latitude.toFixed(7),
        longitude: position.longitude.toFixed(7),
        locationAccuracyMeters: position.accuracy.toFixed(1),
      }, field.key));
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setDeviceBusy('');
    }
  }

  useEffect(() => {
    if (initial || pendingDraft || !spec.refreshDefaults) return;
    setValues((current) => {
      const next = spec.refreshDefaults!(current, manualFields.current);
      return Object.keys(next).some((key) => next[key] !== current[key]) ? next : current;
    });
  }, [initial, pendingDraft, spec]);

  useEffect(() => {
    if (!spec.expenseCategoryDefaults || initial || !creating || !draftReady || pendingDraft || values.type !== 'expense'
      || manualFields.current.has('category') || !contextualDefault.category) return;
    setValues((current) => {
      if (manualFields.current.has('category') || current.type !== 'expense' || current.category === contextualDefault.category) return current;
      const next = { ...current, category: contextualDefault.category };
      if (formDraftFingerprint(current, fileValues) === initialFingerprint.current) initialFingerprint.current = formDraftFingerprint(next, fileValues);
      return next;
    });
  }, [spec.expenseCategoryDefaults, initial, creating, draftReady, pendingDraft, values.type, contextualDefault.category, fileValues]);

  async function save(confirmedWarning?: string, keepOpen = false) {
    if (attachmentProcessing) { setErr('请先确认并应用或放弃当前附件处理，再保存流水。'); return; }
    if (busy || iconBusy || !draftReady || pendingDraft) return;
    setErr(null);
    const normalized = { ...values };
    for (const field of spec.fields) {
      if (field.type === 'text' || field.type === 'textarea') normalized[field.key] = (normalized[field.key] ?? '').trim();
      else if (field.type === 'number') normalized[field.key] = sanitizeNumericInput(normalized[field.key] ?? '');
    }
    const errors: Record<string, string> = requiredFieldErrors(spec.fields, normalized);
    let custom: Record<string, string> | string | undefined;
    try {
      custom = spec.validate?.(normalized, initial);
    } catch {
      setErr('数值格式无效，请检查金额、数量或精度字段。');
      return;
    }
    if (typeof custom === 'string') setErr(custom);
    else if (custom) Object.assign(errors, custom);
    if (typeof custom === 'string' || Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      for (const key of spec.progressiveFields ? Object.keys(errors) : unreachableErrorKeys(spec.fields, normalized, errors, optionalFieldKeys)) await revealField(key);
      const first = Object.keys(errors)[0];
      if (first) queueFocus(first);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const files = Object.fromEntries(spec.fields
        .filter((field) => field.type === 'file')
        .map((field) => [field.key, fileRows(field.key)]));
      const candidate = spec.fromValues(normalized, initial, files);
      if (spec.identityKind === 'scheduled_transaction') {
        const warning = await scheduleDuplicateWarning(store, candidate as unknown as import('@zichan/core').ScheduledTransaction);
        if (warning && warning !== confirmedWarning) { setSaveWarning(warning); setBusy(false); return; }
      }
      await onSave(candidate);
      savedOrDeleted.current = true;
      await draftAutosave.stopAndDrain();
      await deleteFormDraft(draftKey).catch(() => undefined);
      if (keepOpen && onSaveContinue) onSaveContinue(normalized);
      else onClose();
    } catch (e) {
      if (e instanceof DuplicateMasterDataError && e.kind === spec.identityKind) setDuplicates(e);
      setErr(e instanceof Error ? e.message : String(e));
      const rejected = rejectedFieldKey(e, spec.fields);
      if (rejected) {
        setFieldErrors({ [rejected]: e instanceof Error ? e.message : String(e) });
        await revealField(rejected);
        queueFocus(rejected);
      }
      setBusy(false);
    }
  }

  async function del() {
    if (!onDelete) return;
    setBusy(true);
    setErr(null);
    try {
      await onDelete();
      savedOrDeleted.current = true;
      await draftAutosave.stopAndDrain();
      await deleteFormDraft(draftKey).catch(() => undefined);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      throw e;
    }
  }

  async function discardAndClose() {
    savedOrDeleted.current = true;
    await draftAutosave.stopAndDrain();
    await deleteFormDraft(draftKey).catch(() => undefined);
    onClose();
  }

  async function removeAvailableDraft(key: string) {
    if (busy || attachmentProcessing) return;
    try {
      await deleteFormDraft(key);
      setAvailableDrafts((rows) => rows.filter((row) => row.key !== key));
    } catch {
      setErr('删除草稿失败，请重试。');
    }
  }

  async function clearAvailableDrafts() {
    if (busy || attachmentProcessing) return;
    const targets = availableDrafts.filter((draft) => draft.key !== draftKey);
    try {
      await Promise.all(targets.map((draft) => deleteFormDraft(draft.key)));
      setAvailableDrafts((rows) => rows.filter((row) => row.key === draftKey));
    } catch {
      setErr('清空草稿失败，请重试。');
    }
  }

  const fieldErrorEntries = Object.entries(fieldErrors);
  const hasAssetIdField = spec.fields.some((field) => field.key === 'assetId' && !field.hidden);
  const otherDrafts = availableDrafts.filter((draft) => draft.key !== draftKey);

  return (
    <WorkspaceDialog
      workspace={workspace}
      navigationBlocked={dirty || !!pendingDraft}
      onSaveShortcut={() => void save()}
      onSaveContinueShortcut={onSaveContinue ? () => void save(undefined, true) : undefined}
      labelledBy={titleId}
      onDismiss={requestClose}
      dismissDisabled={busy || iconBusy}
      panelClassName={`zc-entity-modal${spec.compactDateTime ? ' zc-transaction-modal' : ''}`}
      panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 26, width: `min(${spec.modalWidth ?? 560}px, 100%)`, maxHeight: '90vh', overflow: 'auto' }}

      header={<>
        <div className={`zc-modal-header${spec.progressiveFields ? ' zc-entry-header' : ''}`}>
          <h2 id={titleId} className="zc-modal-title">{creating ? '新增' : '编辑'} · {spec.title}</h2>
          <div className="zc-modal-header-tools">
            {spec.progressiveFields && !compactView && <span className="zc-entry-mode-label">字段显示</span>}
            {spec.progressiveFields && <div className="zc-entry-modes" role="group" aria-label="字段显示模式">
              <button type="button" className="zc-entry-mode-toggle" aria-label="字段模式：常用" aria-pressed={!fullFields} onClick={() => setFullFields(false)}>常用</button>
              <button type="button" className="zc-entry-mode-toggle" aria-label="字段模式：完整" aria-pressed={fullFields} onClick={() => setFullFields(true)}>完整</button>
            </div>}
            <button type="button" className="zc-dialog-close" aria-label="关闭" title="关闭 (Esc)" onClick={requestClose} disabled={busy || iconBusy}><X size={20} aria-hidden="true" /></button>
          </div>
        </div>
      </>}
      footer={<>
        {err && <div role="alert" className="zc-modal-footer-error">{err}</div>}
        {fieldErrorEntries.length > 0 && (
          <div role="alert" className="zc-modal-error-summary">
            <span className="zc-modal-error-summary-label">还有 {fieldErrorEntries.length} 项待修正：</span>
            <div className="zc-modal-error-pills">
              {fieldErrorEntries.map(([key, message]) => (
                <button
                  key={key}
                  type="button"
                  title={message}
                  className="zc-modal-error-pill"
                  onClick={() => void (async () => {
                    await revealField(key);
                    queueFocus(key);
                  })()}
                >
                  {spec.fields.find((f) => f.key === key)?.label ?? key}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="zc-modal-footer">
          <div className="zc-modal-footer-left">
            {initial && onDelete && (
              <button type="button" className="zc-btn zc-btn--danger" onClick={() => setDeleteOpen(true)} disabled={busy || iconBusy}>{deleteLabel}</button>
            )}
            {!compactView && onSaveContinue && (
              <label className="zc-entry-retain-inline" title="保留日期、账户、币种和分类；金额与描述每次重新填写。">
                <input type="checkbox" checked={retainEntryFields} aria-describedby={`${formId}-continue-note`} onChange={(event) => onRetainEntryFieldsChange?.(event.target.checked)} />
                <span>沿用常用字段</span>
                <span id={`${formId}-continue-note`} className="zc-sr-only">保留日期、账户、币种和分类；金额与描述每次重新填写。</span>
              </label>
            )}
          </div>
          <div className="zc-modal-footer-actions">
            {!draftReady && <span role="status" className="zc-modal-footer-status">
              正在加载草稿…
            </span>}
            <button type="button" className="zc-btn" onClick={requestClose} disabled={busy || iconBusy}>取消</button>
            {!compactView && onSaveContinue && <button type="button" className="zc-btn" title="保存并继续 (Ctrl+Shift+Enter)" disabled={busy || iconBusy || !draftReady || !!pendingDraft} onClick={() => void save(undefined, true)}>保存并继续</button>}
            <button type="button" className="zc-btn zc-btn--primary" title="保存 (Ctrl+Enter)" onClick={() => void save()} disabled={busy || iconBusy || !draftReady || !!pendingDraft}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </>}
    >
      {separateDrafts && otherDrafts.length > 0 && (
        <details className="zc-entry-draft-list">
          <summary>
            <span>未完成草稿 · {otherDrafts.length} 份</span>
          </summary>
          <div className="zc-entry-draft-list-body">
            {otherDrafts.map((draft) => (
              <div className="zc-entry-draft-row" key={draft.key}>
                <span className="zc-entry-draft-meta">
                  {new Date(draft.savedAt).toLocaleString()} · {draft.values.amount || '未填金额'}
                  {Object.values(draft.files).reduce((sum, rows) => sum + rows.length, 0) > 0 && ` · 附件 ${Object.values(draft.files).reduce((sum, rows) => sum + rows.length, 0)} 个`}
                </span>
                <div className="zc-entry-draft-row-actions">
                  <button type="button" className="zc-btn zc-btn--sm" disabled={busy || attachmentProcessing} onClick={() => void restoreAvailableDraft(draft)}>恢复</button>
                  <button type="button" className="zc-btn zc-btn--sm" disabled={busy || attachmentProcessing} onClick={() => void removeAvailableDraft(draft.key)}>删除</button>
                </div>
              </div>
            ))}
            {otherDrafts.length > 1 && (
              <div className="zc-entry-draft-clear-bar">
                <button type="button" className="zc-entry-text-action" disabled={busy || attachmentProcessing} onClick={() => void clearAvailableDrafts()}>清空全部旧草稿</button>
              </div>
            )}
          </div>
        </details>
      )}
      {pendingDraft && <div role="status" className="zc-entry-draft">
        <span title={`未完成的记账：${pendingDraft.values.date ?? ''} ${pendingDraft.values.time ?? ''}，恢复后请核对账户与余额起点。`}>有未完成草稿</span>
        <button type="button" className="zc-entry-text-action" onClick={() => {
          const draft = pendingDraft;
          const manual = new Set(draft.manualFieldKeys ?? Object.keys(draft.values));
          if (spec.expenseCategoryDefaults && draft.values.category) manual.add('category');
          let restored = { ...initialValues, ...draft.values };
          if (!initial && draft.manualFieldKeys && spec.refreshDefaults) restored = spec.refreshDefaults(restored, manual);
          manualFields.current = manual;
          setValues(normalizeValues(spec.fields, restored)); setPrefilledValues(restored);
          setFileValues(Object.fromEntries(Object.entries(draft.files ?? {}).map(([key, rows]) => [key, rows.map((row) => ({ ...row, id: row.id ?? newId() }))]))); setDraftRestoredAt(draft.savedAt); setPendingDraft(null);
        }}>恢复草稿</button>
        <button type="button" className="zc-entry-text-action" onClick={() => void deleteFormDraft(draftKey).then(() => {
          manualFields.current = new Set(Object.keys(initialFieldValues ?? {}).filter((key) => !!initialFieldValues?.[key])); setValues(initialValues); setPrefilledValues(initial ? initialValues : {});
          setFileValues(initialFiles); setDraftRestoredAt(''); setPendingDraft(null);
        }).catch(() => setErr('清除草稿失败，请重试'))}>重新开始</button>
      </div>}
      {draftRestoredAt && (
        <div role="status" className="zc-entry-draft zc-entry-draft--restored">
          <span title={new Date(draftRestoredAt).toLocaleString()}>已恢复草稿，请核对日期和时间</span>
          <button type="button" className="zc-entry-text-action" aria-label="收起草稿恢复提示" onClick={() => setDraftRestoredAt('')}><X size={16} aria-hidden="true" /></button>
        </div>
      )}
      {draftReady && dirty && !pendingDraft && (!spec.compactDateTime || draftAutosave.status.state === 'error') && <FormDraftStatus status={draftAutosave.status} compact={spec.compactDateTime} />}

      {spec.summary?.(values) && <p role="status" className="zc-caption">{spec.summary(values)}</p>}
      {coreGroups.map((group) => <Fragment key={`${group.kind}-${group.title}`}>
        <fieldset className={group.kind === 'standard' ? 'zc-form-task-group' : `zc-entry-section zc-entry-${group.kind}`}>
          {group.title && <legend>{group.title}</legend>}
          <div className={`zc-modal-form-grid${compactEntry ? ' zc-entry-grid' : ''}`} style={{ display: 'grid', gridTemplateColumns: group.kind === 'context' && group.fields.length > 1 ? 'minmax(108px, 0.4fr) minmax(0, 1fr)' : workspace === 'composer' && !compactView ? 'repeat(3, minmax(0, 1fr))' : '1fr 1fr', gap: 12 }}>
            {group.fields.map((f) => {
              const fieldId = `${formId}-${f.key}`;
              const options = optionsWithCreatedAssets(f, values);
              const desktopHalf = !compactEntry && (
                (group.kind === 'context' && group.fields.length > 1)
                || (group.kind === 'primary' && group.fields.length > 1)
                || (group.kind === 'details' && f.type !== 'textarea' && f.type !== 'file' && f.type !== 'allocation' && f.key !== 'refundForId')
              );
              return (
                <FormField
                  key={f.key}
                  f={spec.compactDateTime ? { ...f, half: desktopHalf || (compactEntry && group.kind === 'context' && group.fields.length > 1), placeholder: f.key === 'amount' ? '0.00' : f.placeholder } : workspace === 'composer' && !compactView ? { ...f, half: f.type !== 'textarea' && f.type !== 'file' } : f}
                  compactContext={compactEntry && group.kind === 'context'}
                  fieldId={fieldId}
                  options={options}
                  values={values}
                  value={values[f.key] ?? ''}
                  selectedValues={selectedValues(f.key)}
                  fileRows={fileRows(f.key)}
                  set={set}
                  readFiles={readFiles}
                  setFileRows={(key, rows) => {
                    touched.current = true;
                    setFileValues((current) => ({ ...current, [key]: rows }));
                    set(key, JSON.stringify(rows.map(serializableFile)));
                  }}
                  iconDisabled={busy || !!pendingDraft || !draftReady}
                  onIconBusyChange={setIconBusy}
                  entityId={typeof entity?.id === 'string' ? entity.id : undefined}
                  deviceBusy={deviceBusy === f.key}
                  runDeviceAction={runDeviceAction}
                  error={fieldErrors[f.key]}
                  hint={f.key === 'category' && showContextReason ? contextualDefault.reason : f.hint ?? optionHint(f, options.length)}
                  onAddAssetPreset={f.assetPresetOptions && !preview ? (code) => addAssetPreset(f.key, code) : undefined}
                  onSuffixClick={f.key === 'amount' && hasAssetIdField ? () => { void revealField('assetId').then(() => queueFocus('assetId')); } : undefined}
                  fileControl={spec.privacyAttachments && f.key === 'attachmentDrafts' && !preview ? <LedgerAttachmentField id={fieldId} rows={fileRows(f.key)} disabled={busy || !!pendingDraft || !draftReady} values={values} versions={fieldVersions.current} manual={manualFields.current} assets={optionsWithCreatedAssets(spec.fields.find((field) => field.key === 'assetId')!, values)} onProcessing={setAttachmentProcessing} readFiles={(files) => readFiles(f.key, files)} load={(row) => loadAttachmentContent(store, row)} remove={(id) => { const next = fileRows(f.key).filter((row) => row.id !== id); setFileValues((files) => ({ ...files, [f.key]: next })); set(f.key, JSON.stringify(next.map(serializableFile))); }} apply={applyAttachment} download={(row) => <AttachmentSaveButton attachment={row} />} /> : undefined}
                />
              );
            })}
          </div>
        </fieldset>
        {group.kind === 'primary' && compactDateFields.length > 0 && <div className="zc-entry-datetime" role="group" aria-label="交易日期与时间">
          {compactDateFields.map((f) => <div key={f.key} data-form-field={`${formId}-${f.key}`}>
            <label className="zc-label" htmlFor={`${formId}-${f.key}`}>{f.label}</label>
            <DateTimeInput id={`${formId}-${f.key}`} name={f.key} className="zc-input" type={f.type as 'date' | 'time'} value={values[f.key] ?? ''}
              displayValue={f.type === 'time' ? values[f.key]?.slice(0, 5) : undefined}
              aria-label={f.label} aria-invalid={!!fieldErrors[f.key]} onChange={(next) => set(f.key, next)} required={f.required} />
            {fieldErrors[f.key] && <p className="zc-entry-field-error">{fieldErrors[f.key]}</p>}
          </div>)}
        </div>}
      </Fragment>)}

      {moreFields.length > 0 && (
        <details open={moreExpanded} style={{ marginTop: 16 }}>
          <summary
            onClick={(event) => {
              event.preventDefault();
              setMoreOpen(!moreExpanded);
            }}
            style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}
          >{spec.progressiveFields ? moreFieldsSummaryLabel(visibleMoreFields, values, moreExpanded) : '更多信息'}</summary>
          {visibleMoreFields.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 10 }}>可在“字段显示”里选择要显示的附加字段。</div>
          ) : (
            <div className="zc-modal-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              {visibleMoreFields.map((f) => {
                const fieldId = `${formId}-${f.key}`;
                const options = optionsWithCreatedAssets(f, values);
                return (
                  <FormField
                    key={f.key}
                    f={f}
                    fieldId={fieldId}
                    options={options}
                    values={values}
                    value={values[f.key] ?? ''}
                    selectedValues={selectedValues(f.key)}
                    fileRows={fileRows(f.key)}
                    set={set}
                    readFiles={readFiles}
                    setFileRows={(key, rows) => {
                      touched.current = true;
                      setFileValues((current) => ({ ...current, [key]: rows }));
                      set(key, JSON.stringify(rows.map(serializableFile)));
                    }}
                    iconDisabled={busy || !!pendingDraft || !draftReady}
                    onIconBusyChange={setIconBusy}
                    entityId={typeof entity?.id === 'string' ? entity.id : undefined}
                    deviceBusy={deviceBusy === f.key}
                    runDeviceAction={runDeviceAction}
                    error={fieldErrors[f.key]}
                    hint={f.hint ?? optionHint(f, options.length)}
                    onAddAssetPreset={f.assetPresetOptions && !preview ? (code) => addAssetPreset(f.key, code) : undefined}
                  />
                );
              })}
            </div>
          )}
        </details>
      )}

      {spec.compactDateTime && draftReady && dirty && !pendingDraft && draftAutosave.status.state !== 'error' && <FormDraftStatus status={draftAutosave.status} compact />}

      {duplicates && <div role="alert" className="zc-duplicate-alert">
        <p>{duplicates.message}</p>
        <div className="zc-duplicate-alert-actions">
          {duplicates.matches.map((row) => <button type="button" key={row.id} className="zc-btn" onClick={() => setExistingChoice(row as T)}>
            查看或使用已有：{String(row.groupName ?? row.serverName ?? '')} {String(row.name ?? row.accountName ?? '')}
          </button>)}
          <button type="button" className="zc-btn" onClick={() => { setDuplicates(null); setErr(null); }}>返回修改</button>
        </div>
      </div>}
      {existingChoice && <EntityFormModal spec={spec} initial={existingChoice} onSave={async (value) => { await onSave(value); savedOrDeleted.current = true; await deleteFormDraft(draftKey).catch(() => undefined); onClose(); }} onClose={() => setExistingChoice(undefined)} />}
      {saveWarning && <ConfirmDialog title="可能重复的定期交易" confirmLabel="仍然创建 / 保存" cancelLabel="返回修改" onCancel={() => setSaveWarning(null)} onConfirm={async () => { const warning = saveWarning; setSaveWarning(null); await save(warning); }}>{saveWarning}</ConfirmDialog>}

      {deleteOpen && (
        <ConfirmDialog
          title={`${deleteLabel}${spec.title}`}
          confirmLabel={deleteLabel}
          cancelLabel="取消"
          tone="danger"
          busy={busy}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={del}
        >
          {deleteLabel}后会写入操作历史，并可能影响相关报表。确定继续？
        </ConfirmDialog>
      )}
      {closeOpen && (
        <ConfirmDialog
          title="关闭未保存表单"
          confirmLabel="保留草稿并关闭"
          secondaryLabel="放弃修改并关闭"
          secondaryTone="danger"
          cancelLabel="继续编辑"
          onCancel={() => setCloseOpen(false)}
          onSecondary={discardAndClose}
          onConfirm={() => persistDraftBeforeClose(
            async () => {
              await draftAutosave.drainPending();
              await saveFormDraft(draftKey, values, fileValues, entityVersion, [...manualFields.current]);
            },
            onClose,
          )}
        >
          {separateDrafts ? '当前修改尚未提交。保留草稿可从草稿列表恢复，或直接放弃本次修改。' : '当前修改尚未提交。保留草稿下次打开可继续编辑，或直接放弃本次修改。'}
        </ConfirmDialog>
      )}
    </WorkspaceDialog>
  );
}
