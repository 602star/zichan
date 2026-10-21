import { DuplicateMasterDataError } from '@zichan/db';
import { scheduleDuplicateWarning } from '../master-data-saving.js';
import { EntityIcon, categoryIconValue, categoryOptionIcon } from './EntityIcon.js';
import { EntityIconEditor } from './EntityIconEditor.js';
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Category, Payee } from '@zichan/core';
import { PayeePicker } from './PayeePicker.js';
import { TagPicker } from './TagPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DialogShell } from './DialogShell.js';
import { FormDraftStatus, useFormDraftAutosave } from './FormDraftStatus.js';
import { btnOutline } from './styles.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { readAttachmentBlob, type AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { useCompactView } from './useCompactView.js';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { barcodeScannerAvailable, currentDevicePosition, scanBarcode } from '../device-capabilities.js';
import {
  type FormDraft,
  deleteFormDraft,
  formDraftFingerprint,
  formDraftKey,
  loadFormDraft,
  saveFormDraft,
} from '../db/form-drafts.js';
import {
  emptyOptionHint, progressiveFieldGroups,
  isFieldVisible,
  isMoreFieldVisible,
  requiredFieldErrors,
  unreachableErrorKeys,
} from '../form-validation.js';

export type FieldType = 'icon' | 'text' | 'number' | 'date' | 'time' | 'select' | 'category' | 'multiselect' | 'tags' | 'payee' | 'allocation' | 'checkbox' | 'textarea' | 'file';

export interface FieldOption {
  groupName?: string;
  icon?: string;
  parentId?: string;
  parentIcon?: string;
  parentColor?: string;
  color?: string;
  value: string;
  label: string;
  /**
   * 分类选项自带的结构：自己的名字与父级名（见 `@zichan/core` 的 `CategoryOption`）。
   *
   * 面板要分左右两栏，就直接用它们；`label` 是「一级 / 二级」拼出来的字符串，
   * 而分类名是自由文本，反解会切坏（叶子名里本来就可能带斜杠）。
   */
  name?: string;
  parentName?: string;
  hidden?: boolean;
  /** Present in the immutable system catalog but not enabled in this ledger yet. */
  catalogOnly?: boolean;
  /**
   * 已停用（如扩展包被停用）。与 hidden 不同：停用的分类默认根本不进选项池，
   * 只有读路径（筛选 / 查询）会显式把它带进来，并靠这个标记显示徒标。
   */
  inactive?: boolean;
}

export interface FieldDef {
  key: string;
  label: string;
  relatedValueKeys?: string[];
  payees?: Payee[];
  categories?: Category[];
  iconKind?: 'payee';
  payeeBinding?: { nameKey: string; categoryKey?: string; typeKey?: string; type?: string | ((values: Record<string, string>) => string); textOnly?: boolean };
  type: FieldType;
  options?: FieldOption[] | ((values: Record<string, string>) => FieldOption[]);
  allowEmpty?: boolean; // for select: offer a "（无）" option
  accept?: string;
  multiple?: boolean;
  capture?: 'environment' | 'user';
  deviceAction?: 'scan-barcode' | 'current-location';
  placeholder?: string;
  /** Always-visible helper line under the control, for rules the label cannot carry. */
  hint?: string;
  defaultValue?: string;
  resetWhen?: string[];
  singleOptionSummary?: boolean;
  checkboxValues?: { checked: string; unchecked: string; label: string };
  half?: boolean; // render at half width (two-column grid)
  section?: 'core' | 'more';
  lockedVisible?: boolean;
  required?: boolean;
  categoryShowHiddenDefault?: boolean;
  hidden?: boolean;
  visibleWhen?: (values: Record<string, string>) => boolean;
}

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
  confirmNewDraft?: boolean;
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
    ? `[data-form-field="${CSS.escape(fieldId)}"] input:not([type="hidden"]), [data-form-field="${CSS.escape(fieldId)}"] select, [data-form-field="${CSS.escape(fieldId)}"] textarea`
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
    const optionValues = new Set(options.map((o) => o.value));
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

export function EntityFormModal<T>({ spec, initial, isNew, onSave, onDelete, deleteLabel = '删除', onClose, optionalFieldKeys, onOptionalFieldKeysChange, optionalFieldPresets }: {
  spec: EntityFormSpec<T>;
  initial?: T;
  /** Treat a prefilled entity as a new record rather than an existing record being edited. */
  isNew?: boolean;
  onSave: (entity: T) => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  deleteLabel?: string;
  onClose: () => void;
  optionalFieldKeys?: string[];
  onOptionalFieldKeysChange?: (keys: string[]) => Promise<void> | void;
  optionalFieldPresets?: { label: string; keys: string[] }[];
}) {
  const compactView = useCompactView();
  const { store } = useStore();
  const [duplicates, setDuplicates] = useState<DuplicateMasterDataError | null>(null);
  const [existingChoice, setExistingChoice] = useState<T | undefined>();
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const formId = useId().replace(/:/g, '');
  const titleId = `${formId}-title`;
  const initialValues = useMemo(
    () => initial ? { ...defaults(spec), ...spec.toValues(initial) } : defaults(spec),
    [initial, spec],
  );
  const initialFiles = useMemo<Record<string, FileRow[]>>(() => ({}), []);
  const entity = initial && typeof initial === 'object' ? initial as { id?: unknown; version?: unknown } : undefined;
  const entityVersion = typeof entity?.version === 'number' ? entity.version : undefined;
  const draftKey = formDraftKey(spec.draftKey ?? spec.title, entity);
  const initialFingerprint = useRef(formDraftFingerprint(initialValues, initialFiles));
  const touched = useRef(false);
  const manualFields = useRef(new Set(initial ? Object.keys(spec.toValues(initial)).filter((key) => !!spec.toValues(initial)[key]) : []));
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
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState('');
  const [fileValues, setFileValues] = useState<Record<string, FileRow[]>>(initialFiles);
  const [draftReady, setDraftReady] = useState(false);
  const draftHandled = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<FormDraft | null>(null);
  const [draftRestoredAt, setDraftRestoredAt] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const creating = isNew ?? !initial;

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
    void loadFormDraft(draftKey, entityVersion)
      .then((draft) => {
        if (cancelled) return;
        draftHandled.current = true;
        if (!draft || touched.current) return;
        if (creating && spec.confirmNewDraft) { setPendingDraft(draft); return; }
        const restored = normalizeValues(spec.fields, { ...initialValues, ...draft.values });
        setValues(restored);
        setPrefilledValues(restored);
        manualFields.current = new Set(Object.keys(draft.values).filter((key) => draft.values[key] !== initialValues[key]));
        setFileValues(draft.files ?? {});
        setDraftRestoredAt(draft.savedAt);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [draftKey, entityVersion, initialValues, spec.fields, spec.confirmNewDraft, creating]);

  useEffect(() => {
    if (pendingDraft || !dirty || savedOrDeleted.current) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, pendingDraft]);

  const set = (key: string, value: string) => {
    touched.current = true;
    manualFields.current.add(key);
    setValues((v) => { const next = { ...v, [key]: value }; return normalizeValues(spec.fields, spec.onFieldChange?.(next, key, manualFields.current) ?? next, key); });
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
  const moreFields = groups?.more ?? allMoreFields.filter((f) => isFieldVisible(f, values));
  const coreFields = groups?.core ?? spec.fields.filter((f) => f.section !== 'more' && isFieldVisible(f, values));
  const visibleOptional = new Set(optionalFieldKeys ?? moreFields.map((f) => f.key));
  const visibleMoreFields = groups ? moreFields : moreFields.filter((f) => isMoreFieldVisible(f, values, optionalFieldKeys, allMoreFieldKeys));
  const moreExpanded = moreOpen ?? spec.moreInitiallyOpen ?? visibleMoreFields.length > 0;
  const toggleOptionalField = async (key: string) => {
    const current = new Set(optionalFieldKeys ?? moreFields.map((f) => f.key));
    if (current.has(key)) current.delete(key);
    else current.add(key);
    await onOptionalFieldKeysChange?.([...current]);
  };
  /** Bring a blocking field back into view: unfold 更多信息 and switch the picker on. */
  const revealField = async (key: string) => {
    const field = spec.fields.find((f) => f.key === key);
    if (!field || !isFieldVisible(field, values)) return;
    if (field.section !== 'more' && !compactKeys.includes(key)) return;
    setMoreOpen(true);
    if (spec.progressiveFields || isMoreFieldVisible(field, values, optionalFieldKeys, allMoreFieldKeys)) return;
    const current = new Set(optionalFieldKeys ?? moreFields.map((f) => f.key));
    current.add(key);
    await onOptionalFieldKeysChange?.([...current]);
  };
  /** Scroll and focus a field once it is on screen; retries across a few renders. */
  const queueFocus = (key: string) => {
    focusAttempts.current = 0;
    setPendingFocus(key);
  };
  useEffect(() => {
    if (!pendingFocus) return;
    const field = spec.fields.find((f) => f.key === pendingFocus);
    if (field && !isFieldVisible(field, values)) {
      setPendingFocus(null);
      return;
    }
    if (field?.section === 'more' || compactKeys.includes(pendingFocus)) setMoreOpen(true);
    const node = focusTarget(`${formId}-${pendingFocus}`);
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
  }, [pendingFocus, formId, spec.fields, values, compactKeys]);
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
      const next = await Promise.all([...files].map((file) => prepareFile(file, maxBytes)));
      const combined = [...current, ...next];
      touched.current = true;
      setFileValues((rows) => ({ ...rows, [key]: combined }));
      set(key, JSON.stringify(combined.map(serializableFile)));
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
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
      setValues((current) => normalizeValues(spec.fields, {
        ...current,
        [field.key]: current[field.key]?.trim() || '当前位置',
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

  async function save(confirmedWarning?: string) {
    if (busy || iconBusy || !draftReady || pendingDraft) return;
    setErr(null);
    const normalized = { ...values };
    for (const field of spec.fields) {
      if (field.type === 'text' || field.type === 'textarea') normalized[field.key] = (normalized[field.key] ?? '').trim();
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
      for (const key of unreachableErrorKeys(spec.fields, normalized, errors, optionalFieldKeys)) await revealField(key);
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
      onClose();
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

  return (
    <DialogShell
      labelledBy={titleId}
      onDismiss={requestClose}
      dismissDisabled={busy || iconBusy}
      panelClassName="zc-entity-modal"
      panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 26, width: `min(${spec.modalWidth ?? 560}px, 100%)`, maxHeight: '90vh', overflow: 'auto' }}
    >
        <div className="zc-modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{creating ? '新增' : '编辑'} · {spec.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(spec.optionalFieldOptions?.length || moreFields.length > 0) && onOptionalFieldKeysChange && (
              <button
                onClick={() => setFieldPickerOpen((v) => !v)}
                style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' }}
              >
                {spec.progressiveFields ? '常用附加字段' : '字段显示'}
              </button>
            )}
            <button type="button" data-dialog-initial-focus aria-label="关闭" onClick={requestClose} disabled={busy || iconBusy} style={{ border: 'none', background: 'transparent', fontSize: 'var(--fs-heading)', cursor: busy ? 'not-allowed' : 'pointer', color: 'var(--text-tertiary)', opacity: busy ? 0.6 : 1 }}>×</button>
          </div>
        </div>

        {pendingDraft && <div role="status" style={{ padding: 12, marginBottom: 12, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <p>发现未完成的记账草稿（{pendingDraft.values.date} {pendingDraft.values.time}）。恢复后会保留原记录时间，请核对账户和余额起点。</p>
          <button type="button" onClick={() => {
            const draft = pendingDraft;
            const manual = new Set(draft.manualFieldKeys ?? Object.keys(draft.values));
            let restored = { ...initialValues, ...draft.values };
            if (!initial && draft.manualFieldKeys && spec.refreshDefaults) restored = spec.refreshDefaults(restored, manual);
            manualFields.current = manual;
            setValues(normalizeValues(spec.fields, restored)); setPrefilledValues(restored);
            setFileValues(draft.files ?? {}); setDraftRestoredAt(draft.savedAt); setPendingDraft(null);
          }}>恢复草稿</button>
          <button type="button" onClick={() => void deleteFormDraft(draftKey).then(() => {
            manualFields.current = new Set(); setValues(initialValues); setPrefilledValues(initial ? initialValues : {});
            setFileValues(initialFiles); setDraftRestoredAt(''); setPendingDraft(null);
          }).catch(() => setErr('清除草稿失败，请重试'))}>重新开始</button>
        </div>}
        {draftRestoredAt && (
          <div role="status" style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>
            已恢复 {new Date(draftRestoredAt).toLocaleString()} 自动保存的草稿。
          </div>
        )}
        {draftReady && dirty && !pendingDraft && <FormDraftStatus status={draftAutosave.status} />}

        {spec.summary?.(values) && <p role="status" className="zc-caption">{spec.summary(values)}</p>}
        {fieldPickerOpen && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)' }}>{spec.progressiveFields ? '常用附加字段' : '更多信息字段'}</div>
              {optionalFieldPresets && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {optionalFieldPresets.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => void onOptionalFieldKeysChange?.(preset.keys)}
                      style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', background: 'var(--surface)', color: 'var(--text-secondary)', padding: '5px 9px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {spec.progressiveFields && <p className="zc-caption">勾选的字段在新增记账时直接展开。其他字段可在更多信息中填写；编辑时已有内容会自动显示。</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(spec.optionalFieldOptions ? spec.optionalFieldOptions.map((option) => ({ ...spec.fields.find((f) => f.key === option.key)!, label: option.label })) : allMoreFields).map((f) => (
                <label key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '6px 10px', background: 'var(--surface)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={f.lockedVisible || f.required || visibleOptional.has(f.key)} disabled={f.lockedVisible || f.required || busy} onChange={() => void toggleOptionalField(f.key)} />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="zc-modal-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {coreFields.map((f) => {
            const fieldId = `${formId}-${f.key}`;
            const options = fieldOptions(f, values);
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
              />
            );
          })}
        </div>

        {moreFields.length > 0 && (
          <details open={moreExpanded} style={{ marginTop: 16 }}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setMoreOpen(!moreExpanded);
              }}
              style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}
            >更多信息</summary>
            {visibleMoreFields.length === 0 ? (
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 10 }}>可在“字段显示”里选择要显示的附加字段。</div>
            ) : (
              <div className="zc-modal-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                {visibleMoreFields.map((f) => {
                  const fieldId = `${formId}-${f.key}`;
                  const options = fieldOptions(f, values);
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
                    />
                  );
                })}
              </div>
            )}
          </details>
        )}

        {duplicates && <div role="alert">
          <p>{duplicates.message}</p>
          {duplicates.matches.map((row) => <button type="button" key={row.id} style={btnOutline} onClick={() => setExistingChoice(row as T)}>
            查看或使用已有：{String(row.groupName ?? row.serverName ?? '')} {String(row.name ?? row.accountName ?? '')}
          </button>)}
          <button type="button" style={btnOutline} onClick={() => { setDuplicates(null); setErr(null); }}>返回修改</button>
        </div>}
        {existingChoice && <EntityFormModal spec={spec} initial={existingChoice} onSave={async (value) => { await onSave(value); savedOrDeleted.current = true; await deleteFormDraft(draftKey).catch(() => undefined); onClose(); }} onClose={() => setExistingChoice(undefined)} />}
        {saveWarning && <ConfirmDialog title="可能重复的定期交易" confirmLabel="仍然创建 / 保存" cancelLabel="返回修改" onCancel={() => setSaveWarning(null)} onConfirm={async () => { const warning = saveWarning; setSaveWarning(null); await save(warning); }}>{saveWarning}</ConfirmDialog>}
        {err && <div role="alert" style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', marginTop: 12 }}>{err}</div>}

        {Object.keys(fieldErrors).length > 0 && (
          <div role="alert" style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginBottom: 8 }}>还有 {Object.keys(fieldErrors).length} 项需要处理，点标签可直接跳到对应字段：</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(fieldErrors).map(([key, message]) => (
                <button
                  key={key}
                  type="button"
                  title={message}
                  onClick={() => void (async () => {
                    await revealField(key);
                    queueFocus(key);
                  })()}
                  style={{ border: '1px solid var(--negative)', borderRadius: 'var(--r-pill)', background: 'var(--surface)', color: 'var(--negative)', padding: '5px 10px', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' }}
                >
                  {spec.fields.find((f) => f.key === key)?.label ?? key}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="zc-modal-footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 }}>
          <div>
            {initial && onDelete && (
              <button onClick={() => setDeleteOpen(true)} disabled={busy || iconBusy} style={{ padding: '9px 16px', borderRadius: 'var(--r-sm)', border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>{deleteLabel}</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {(!draftReady || pendingDraft) && <span role="status" style={{ alignSelf: 'center', color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>
              {pendingDraft ? '请先处理上方草稿' : '正在加载草稿…'}
            </span>}
            <button onClick={requestClose} disabled={busy || iconBusy} style={{ padding: '9px 18px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-bold)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>取消</button>
            <button onClick={() => void save()} disabled={busy || iconBusy || !draftReady || !!pendingDraft} style={{ padding: '9px 18px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', cursor: 'pointer', opacity: busy || !draftReady || !!pendingDraft ? 0.6 : 1 }}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
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
            cancelLabel="继续编辑"
            onCancel={() => setCloseOpen(false)}
            onConfirm={() => persistDraftBeforeClose(
              async () => {
                await draftAutosave.drainPending();
                await saveFormDraft(draftKey, values, fileValues, entityVersion, [...manualFields.current]);
              },
              onClose,
            )}
          >
            当前修改尚未提交。关闭后会保留自动草稿，下次打开同一表单时继续填写。
          </ConfirmDialog>
        )}
    </DialogShell>
  );
}

function FormField(props: {
  f: FieldDef;
  values: Record<string, string>;
  fieldId: string;
  options: FieldOption[];
  value: string;
  selectedValues: string[];
  fileRows: FileRow[];
  set: (key: string, value: string) => void;
  readFiles: (key: string, files: FileList | null) => Promise<void>;
  setFileRows: (key: string, rows: FileRow[]) => void;
  entityId?: string;
  iconDisabled: boolean;
  onIconBusyChange: (busy: boolean) => void;
  deviceBusy: boolean;
  runDeviceAction: (field: FieldDef) => Promise<void>;
  error?: string;
  hint?: string;
}) {
  const { f, values, fieldId, options, value, selectedValues, fileRows, set, readFiles, setFileRows, deviceBusy, runDeviceAction, error, hint } = props;
  const binding = f.payeeBinding;
  const payeeType = typeof binding?.type === 'function' ? binding.type(values) : binding?.type ?? values[binding?.typeKey ?? 'type'] ?? 'expense';
  return (
    <div className="zc-form-field" key={f.key} data-form-field={fieldId} style={{ gridColumn: f.half ? 'span 1' : 'span 2' }}>
      <label className="zc-label" htmlFor={fieldId}>{f.type === 'payee' && payeeType === 'income' ? '付款方' : f.label}{f.required && <span style={{ color: 'var(--negative)', marginLeft: 3 }}>*</span>}</label>
      {f.type === 'select' && f.singleOptionSummary && options.length === 1 ? <output id={fieldId} aria-label={f.label} style={{ display: 'block', padding: '8px 0' }}>{options[0]!.label}</output> : f.type === 'select' ? (
        <select id={fieldId} name={f.key} className="zc-select" required={f.required} value={value} onChange={(e) => set(f.key, e.target.value)}>
          {f.allowEmpty && <option value="">（无）</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : f.type === 'icon' ? (
        <EntityIconEditor disabled={props.iconDisabled} id={fieldId} value={value} platformId={f.iconKind === 'payee' ? props.entityId : undefined} platformName={f.iconKind === 'payee' ? values.name : undefined}
          defaultIcon={f.iconKind === 'payee' ? undefined : categoryIconValue(props.entityId ?? values.parentId ?? '', (f.categories ?? []).map((row) => row.id === props.entityId ? { ...row, icon: undefined, parentId: values.parentId } : row))}
          onChange={(next) => set(f.key, next)} onBusyChange={props.onIconBusyChange} />
      ) : f.type === 'category' ? (
        <CategoryPicker
          fieldId={fieldId}
          name={f.key}
          value={value}
          options={options}
          allowEmpty={f.allowEmpty}
          defaultShowHidden={f.categoryShowHiddenDefault}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'payee' ? (
        <PayeePicker id={fieldId} payees={f.payees ?? []} categories={f.categories ?? []} payeeId={binding?.textOnly ? '' : value} merchant={values[binding?.nameKey ?? 'merchant'] ?? ''} categoryId={values[binding?.categoryKey ?? 'category'] ?? ''} type={payeeType} textOnly={binding?.textOnly} onChange={(id, name) => { if (!binding?.textOnly) set(f.key, id); set(binding?.nameKey ?? 'merchant', name); }} />
      ) : f.type === 'tags' ? (
        <TagPicker id={fieldId} options={options} value={value} onChange={(next) => set(f.key, next)} />
      ) : f.type === 'multiselect' ? (
        <select
          id={fieldId}
          name={f.key}
          className="zc-select"
          multiple
          value={selectedValues}
          onChange={(e) => set(f.key, [...e.currentTarget.selectedOptions].map((o) => o.value).join(','))}
          style={{ minHeight: 92, paddingTop: 8, paddingBottom: 8 }}
          required={f.required}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : f.type === 'allocation' ? (
        <AllocationEditor
          fieldId={fieldId}
          options={options}
          value={value}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-body)', color: 'var(--text-primary)', paddingTop: 4 }}>
          <input id={fieldId} name={f.key} type="checkbox" aria-label={f.label} checked={value === (f.checkboxValues?.checked ?? 'true')} onChange={(e) => set(f.key, e.target.checked ? (f.checkboxValues?.checked ?? 'true') : (f.checkboxValues?.unchecked ?? 'false'))} />
          {f.checkboxValues?.label ?? '启用'}
        </label>
      ) : f.type === 'textarea' ? (
        <textarea
          id={fieldId}
          name={f.key}
          className="zc-input"
          value={value}
          placeholder={f.placeholder}
          onChange={(e) => set(f.key, e.target.value)}
          style={{ minHeight: 96, resize: 'vertical', paddingTop: 10 }}
          required={f.required}
        />
      ) : f.type === 'file' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id={fieldId}
              name={f.key}
              className="zc-input"
              type="file"
              accept={f.accept}
              multiple={f.multiple !== false}
              onChange={(e) => void readFiles(f.key, e.currentTarget.files)}
              style={{ paddingTop: 8, flex: 1, minWidth: 0 }}
              required={f.required}
            />
            {f.capture && (
              <>
                <input id={`${fieldId}-camera`} type="file" accept="image/*" capture={f.capture} onChange={(e) => void readFiles(f.key, e.currentTarget.files)} style={{ display: 'none' }} />
                <label className="zc-device-action" htmlFor={`${fieldId}-camera`} title="使用相机拍照" style={{ flex: '0 0 auto', height: 38, display: 'inline-flex', alignItems: 'center', padding: '0 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text-secondary)', background: 'var(--surface-2)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' }}>拍照</label>
              </>
            )}
          </div>
          {fileRows.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {fileRows.map((row, idx) => (
                <div key={`${row.fileName}:${idx}`} style={{ width: 82, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', position: 'relative' }}>
                  <AttachmentPreview attachment={row} alt={row.fileName} style={{ width: 74, height: 54, objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3 }}>{row.fileName}</div>
                  {row.sizeBytes && <div>{row.sizeBytes > 1024 * 1024 ? `${(row.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`}</div>}
                  <AttachmentSaveButton attachment={row} />
                  <button type="button" title="移除附件" aria-label={`移除 ${row.fileName}`} onClick={() => setFileRows(f.key, fileRows.filter((_, rowIndex) => rowIndex !== idx))} style={{ position: 'absolute', top: -5, right: 2, width: 20, height: 20, borderRadius: 'var(--r-round)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--negative)', cursor: 'pointer', lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id={fieldId}
            name={f.key}
            className="zc-input"
            type={f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'text'}
            inputMode={f.type === 'number' ? 'decimal' : undefined}
            value={value}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key, e.target.value)}
            required={f.required}
            style={{ flex: 1, minWidth: 0 }}
          />
          {f.deviceAction && (f.deviceAction !== 'scan-barcode' || barcodeScannerAvailable()) && (
            <button type="button" title={f.deviceAction === 'scan-barcode' ? '扫描条形码或二维码' : '读取当前位置'} disabled={deviceBusy} onClick={() => void runDeviceAction(f)} style={{ flex: '0 0 auto', height: 38, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text-secondary)', background: 'var(--surface-2)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: deviceBusy ? 'wait' : 'pointer' }}>
              {deviceBusy ? '读取中…' : f.deviceAction === 'scan-barcode' ? '扫码' : '定位'}
            </button>
          )}
        </div>
      )}
      {error && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', marginTop: 4 }}>{error}</div>}
      {!error && hint && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function AllocationEditor(props: {
  fieldId: string;
  options: FieldOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  let values: Record<string, string> = {};
  try {
    const parsed = JSON.parse(props.value || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed as Record<string, string>;
  } catch {
    values = {};
  }
  const update = (key: string, amount: string) => {
    const next = { ...values };
    if (amount.trim()) next[key] = amount;
    else delete next[key];
    props.onChange(JSON.stringify(next));
  };
  if (!props.options.length) return <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>先选择原支出</div>;
  return (
    <div id={props.fieldId} style={{ border: '1px solid var(--border)', maxHeight: 210, overflowY: 'auto', background: 'var(--surface)' }}>
      {props.options.map((option) => (
        <label key={option.value} className="zc-refund-option-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: 10, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-caption)' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</span>
          <input className="zc-input" inputMode="decimal" value={values[option.value] ?? ''} onChange={(event) => update(option.value, event.target.value)} placeholder="退款金额" />
        </label>
      ))}
    </div>
  );
}

function AttachmentSaveButton({ attachment }: { attachment: AttachmentDraftData }) {
  const { store } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      let blob = attachment.contentBlob;
      if (!blob) {
        if (!attachment.sha256 || attachment.sizeBytes == null) throw new Error('附件缺少正文引用');
        await ensureAttachmentBlobAvailable(store, {
          sha256: attachment.sha256,
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType || 'application/octet-stream',
        });
        blob = await readAttachmentBlob(attachment.sha256, attachment.mimeType);
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title={error || `保存 ${attachment.fileName}`}
      onClick={() => void save()}
      disabled={busy}
      style={{ marginTop: 3, border: 0, padding: 0, background: 'transparent', color: error ? 'var(--negative)' : 'var(--accent)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)', cursor: busy ? 'wait' : 'pointer' }}
    >
      {busy ? '取回中…' : error ? '重试' : '保存'}
    </button>
  );
}

/*
 * 把选项拆成面板要的两栏。
 *
 * 选项自带结构（`name` / `parentName`）时直接用。退回解析 `label` 只是为了兼容
 * 手搓选项的调用点：`label` 的两段是拼出来的，而分类名是用户可编辑的自由文本，
 * 叶子名本身就可能带斜杠（目录里的「打车/网约车」）。按 `/` 反解会把它切成两级，
 * 重拼时再各补一个空格，面板里就变成了「打车 / 网约车」；父级名带斜杠时更糟，
 * 会凭空造出一个一级分组（「学习/培训」变成一级「学习」、二级「培训 / 教材」）。
 */
export function splitCategoryLabel(option: FieldOption): { parent: string; child: string } {
  if (option.name !== undefined) return { parent: option.parentName ?? '其他', child: option.name };
  const parts = option.label.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { parent: parts[0]!, child: parts.slice(1).join(' / ') };
  return { parent: '其他', child: option.label };
}

function categoryGroups(options: FieldOption[], search: string, selectedValue: string, showHidden: boolean): { parent: string; children: FieldOption[] }[] {
  const q = search.trim().toLowerCase();
  const grouped = new Map<string, FieldOption[]>();
  for (const option of options) {
    if (option.catalogOnly && !q && option.value !== selectedValue) continue;
    if (option.hidden && !showHidden && !q && option.value !== selectedValue) continue;
    const parsed = splitCategoryLabel(option);
    const hit = !q || option.label.toLowerCase().includes(q) || parsed.parent.toLowerCase().includes(q) || parsed.child.toLowerCase().includes(q);
    if (!hit) continue;
    const rows = grouped.get(parsed.parent) ?? [];
    rows.push(option);
    grouped.set(parsed.parent, rows);
  }
  return [...grouped.entries()].map(([parent, children]) => ({ parent, children }));
}

export function CategoryPicker(props: {
  fieldId: string; name: string; value: string; options: FieldOption[];
  allowEmpty?: boolean; defaultShowHidden?: boolean; onChange: (value: string) => void;
  emptyLabel?: string; placeholder?: string; ariaLabel?: string; triggerStyle?: CSSProperties;
}) {
  const { fieldId, name, value, options, allowEmpty, defaultShowHidden = false, onChange,
    emptyLabel = '不选择', placeholder = '选择分类', ariaLabel, triggerStyle } = props;
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeParent, setActiveParent] = useState('');
  const [childrenStep, setChildrenStep] = useState(false);
  const [compact, setCompact] = useState(false);
  const [showHidden, setShowHidden] = useState(defaultShowHidden);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);
  const selectedParts = selected ? splitCategoryLabel(selected) : undefined;
  const groups = categoryGroups(options, search, value, showHidden);
  const hiddenCount = options.filter((option) => option.hidden && !option.catalogOnly).length;
  const activeGroup = groups.find((group) => group.parent === activeParent)
    ?? groups.find((group) => group.children.some((child) => child.value === value)) ?? groups[0];
  const searching = Boolean(search.trim());
  const choose = (next: string) => { onChange(next); setOpen(false); };

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const vw = viewport?.width ?? window.innerWidth;
      const vh = viewport?.height ?? window.innerHeight;
      const ox = viewport?.offsetLeft ?? 0;
      const oy = viewport?.offsetTop ?? 0;
      const width = Math.min(540, vw - 20);
      setCompact(width < 340);
      const panel = document.getElementById(titleId)?.closest('[role="dialog"]');
      const height = Math.min(panel?.getBoundingClientRect().height || 400, 420, vh - 20);
      const below = oy + vh - rect.bottom - 16;
      const above = rect.top - oy - 16;
      const down = below >= Math.min(height, 240) || below >= above;
      const maxHeight = Math.max(100, Math.min(420, vh - 20, down ? below : above));
      const actualHeight = Math.min(height, maxHeight);
      const desired = down ? rect.bottom + 6 : rect.top - actualHeight - 6;
      setPlacement({ width, maxHeight, left: Math.max(ox + 10, Math.min(rect.left, ox + vw - width - 10)),
        top: Math.max(oy + 10, Math.min(desired, oy + vh - actualHeight - 10)) });
    };
    position();
    const panel = document.getElementById(titleId)?.closest('[role="dialog"]');
    const observer = new ResizeObserver(position);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, titleId, searching, activeParent, childrenStep]);

  const optionRow = (option: FieldOption, parent: string) => {
    const parsed = splitCategoryLabel(option);
    return <button key={option.value} type="button" role="option" aria-selected={value === option.value}
      onClick={() => choose(option.value)} style={categoryChildButton(value === option.value)}>
      <EntityIcon icon={categoryOptionIcon(option)} color={option.color} />
      <span className="zc-category-option-text">{searching && <small>{parent} › </small>}{parsed.child}</span>
      {option.catalogOnly ? <span style={categoryHiddenBadge()}>未启用</span>
        : option.inactive ? <span style={categoryHiddenBadge('inactive')}>已停用</span>
          : option.hidden && <span style={categoryHiddenBadge()}>隐藏</span>}
    </button>;
  };

  return <div style={{ minWidth: 0 }}>
    <button ref={trigger} id={fieldId} name={name} type="button" className="zc-select zc-category-trigger"
      aria-haspopup="dialog" aria-expanded={open} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      onClick={() => { setSearch(''); setChildrenStep(Boolean(selected)); setActiveParent(selectedParts?.parent ?? ''); setOpen(true); }}
      style={{ ...triggerStyle, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', whiteSpace: 'normal', height: 'auto' }}>
      {selected && <EntityIcon icon={categoryOptionIcon(selected)} color={selected.color} />}
      <span className="zc-category-option-text">{selected ? <><small>{selectedParts?.parent} › </small><b>{selectedParts?.child}</b></> : placeholder}</span>
      <span aria-hidden="true">{open ? '▲' : '▼'}</span>
    </button>
    {open && <DialogShell labelledBy={titleId} onDismiss={() => setOpen(false)}
      backdropClassName="zc-category-backdrop" panelClassName="zc-category-picker-panel"
      panelStyle={{ position: 'fixed', ...placement }}>
      <span id={titleId} className="zc-category-accessible-title">选择分类</span>
      <div className="zc-category-picker-search">
        <input className="zc-input" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索分类" aria-label="搜索分类" />
        <button type="button" className="zc-category-close" aria-label="关闭分类选择" onClick={() => setOpen(false)}>×</button>
        {hiddenCount > 0 && <button type="button" className="zc-category-scope" aria-pressed={showHidden}
          onClick={() => setShowHidden((current) => !current)}>{showHidden ? '只看高频' : `显示隐藏 (${hiddenCount})`}</button>}
      </div>
      {searching ? <div className="zc-category-picker-list" role="listbox" aria-label="分类搜索结果">
        {groups.flatMap((group) => group.children.map((option) => optionRow(option, group.parent)))}
        {!groups.length && <p className="zc-meta">没有匹配分类</p>}
      </div> : <>
        <div className="zc-category-step-nav">
          {childrenStep ? <button type="button" style={btnOutline} onClick={() => setChildrenStep(false)}>返回一级分类</button> : <span>选择一级分类</span>}
          {childrenStep && <strong className="zc-category-option-text">{activeGroup?.parent}</strong>}
        </div>
        <div className={`zc-category-picker-grid${childrenStep ? ' is-children' : ''}`}>
          <div className="zc-category-picker-list zc-category-parents" hidden={compact && childrenStep}>
            {allowEmpty && <button type="button" onClick={() => choose('')} style={categoryParentButton(!value)}>{emptyLabel}</button>}
            {groups.map((group) => <button key={group.parent} type="button" aria-pressed={activeGroup?.parent === group.parent}
              onClick={() => { setActiveParent(group.parent); setChildrenStep(true); }} style={categoryParentButton(activeGroup?.parent === group.parent)}>
              <EntityIcon icon={group.children[0]?.parentIcon || categoryIconValue(group.children[0]?.parentId ?? '')} color={group.children[0]?.parentColor ?? group.children[0]?.color} />
              <span className="zc-category-option-text">{group.parent}</span>
            </button>)}
            {!groups.length && <p className="zc-meta">没有可选分类</p>}
          </div>
          <div className="zc-category-picker-list zc-category-children" hidden={compact && !childrenStep} role="listbox" aria-label={activeGroup?.parent ?? '二级分类'}>
            {activeGroup?.children.map((option) => optionRow(option, activeGroup.parent))}
          </div>
        </div>
      </>}
    </DialogShell>}
  </div>;
}


function categoryParentButton(active: boolean) {
  return {
    width: '100%',
    minHeight: 46,
    border: 'none',
    borderRadius: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--fg-muted)',
    fontSize: 'var(--fs-body)',
    fontWeight: active ? 'var(--fw-medium)' : 'var(--fw-regular)',
    cursor: 'pointer',
    textAlign: 'left',
  } as const;
}

function categoryHiddenBadge(tone: 'muted' | 'inactive' = 'muted') {
  const inactive = tone === 'inactive';
  return {
    border: `1px solid ${inactive ? 'var(--border-strong, var(--border))' : 'var(--border)'}`,
    borderRadius: 'var(--r-pill)',
    padding: '2px 6px',
    color: inactive ? 'var(--text-secondary)' : 'var(--text-tertiary)',
    background: 'var(--surface-2)',
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-medium)',
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
  } as const;
}

function categoryChildButton(active: boolean) {
  return {
    width: '100%',
    minHeight: 46,
    border: 'none',
    borderRadius: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--fg)',
    fontSize: 'var(--fs-body)',
    fontWeight: active ? 'var(--fw-medium)' : 'var(--fw-regular)',
    cursor: 'pointer',
    textAlign: 'left',
  } as const;
}
