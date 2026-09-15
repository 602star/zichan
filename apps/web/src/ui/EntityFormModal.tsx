import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DialogShell } from './DialogShell.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { readAttachmentBlob, type AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { barcodeScannerAvailable, currentDevicePosition, scanBarcode } from '../device-capabilities.js';
import {
  deleteFormDraft,
  formDraftFingerprint,
  formDraftKey,
  loadFormDraft,
  saveFormDraft,
} from '../db/form-drafts.js';
import {
  emptyOptionHint,
  isFieldVisible,
  isMoreFieldVisible,
  requiredFieldErrors,
  unreachableErrorKeys,
} from '../form-validation.js';

export type FieldType = 'text' | 'number' | 'date' | 'time' | 'select' | 'category' | 'multiselect' | 'allocation' | 'checkbox' | 'textarea' | 'file';

export interface FieldOption {
  value: string;
  label: string;
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
  type: FieldType;
  options?: FieldOption[] | ((values: Record<string, string>) => FieldOption[]);
  allowEmpty?: boolean; // for select: offer a "（无）" option
  accept?: string;
  multiple?: boolean;
  capture?: 'environment' | 'user';
  deviceAction?: 'scan-barcode' | 'current-location';
  placeholder?: string;
  defaultValue?: string;
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
  /** Stable namespace for auto-saved drafts. Defaults to the form title. */
  draftKey?: string;
  modalWidth?: number;
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

function serializableFile(row: FileRow): Omit<FileRow, 'contentBlob' | 'thumbnailBlob'> {
  const { contentBlob: _content, thumbnailBlob: _thumbnail, ...metadata } = row;
  return metadata;
}

async function prepareFile(file: File): Promise<FileRow> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 100 MB 限制`);
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
      const shouldReset = current && !optionValues.has(current);
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
  const savedOrDeleted = useRef(false);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [busy, setBusy] = useState(false);
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
  const [draftRestoredAt, setDraftRestoredAt] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const creating = isNew ?? !initial;

  const fingerprint = formDraftFingerprint(values, fileValues);
  const dirty = fingerprint !== initialFingerprint.current;

  useEffect(() => {
    let cancelled = false;
    void loadFormDraft(draftKey, entityVersion)
      .then((draft) => {
        if (cancelled || !draft || touched.current) return;
        setValues(normalizeValues(spec.fields, { ...initialValues, ...draft.values }));
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
  }, [draftKey, entityVersion, initialValues, spec.fields]);

  useEffect(() => {
    if (!draftReady || !dirty || savedOrDeleted.current) return;
    const timer = window.setTimeout(() => {
      void saveFormDraft(draftKey, values, fileValues, entityVersion).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draftKey, draftReady, dirty, entityVersion, fileValues, values]);

  useEffect(() => {
    if (!dirty || savedOrDeleted.current) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const set = (key: string, value: string) => {
    touched.current = true;
    setValues((v) => normalizeValues(spec.fields, { ...v, [key]: value }, key));
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setCloseOpen(true);
    else onClose();
  };
  const allMoreFields = spec.fields.filter((f) => f.section === 'more' && !f.hidden);
  const allMoreFieldKeys = allMoreFields.map((f) => f.key);
  const moreFields = allMoreFields.filter((f) => isFieldVisible(f, values));
  const coreFields = spec.fields.filter((f) => f.section !== 'more' && isFieldVisible(f, values));
  const visibleOptional = new Set(optionalFieldKeys ?? moreFields.map((f) => f.key));
  const visibleMoreFields = moreFields.filter((f) => isMoreFieldVisible(f, values, optionalFieldKeys, allMoreFieldKeys));
  const moreExpanded = moreOpen ?? visibleMoreFields.length > 0;
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
    if (field.section !== 'more') return;
    setMoreOpen(true);
    if (isMoreFieldVisible(field, values, optionalFieldKeys, allMoreFieldKeys)) return;
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
    if (field?.section === 'more') setMoreOpen(true);
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
  }, [pendingFocus, formId, spec.fields, values]);
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
      const next = await Promise.all([...files].map(prepareFile));
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

  async function save() {
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
      await onSave(spec.fromValues(normalized, initial, files));
      savedOrDeleted.current = true;
      await deleteFormDraft(draftKey).catch(() => undefined);
      onClose();
    } catch (e) {
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
      dismissDisabled={busy}
      panelClassName="zc-entity-modal"
      panelStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 26, width: `min(${spec.modalWidth ?? 560}px, 100%)`, maxHeight: '90vh', overflow: 'auto' }}
    >
        <div className="zc-modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div id={titleId} style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{creating ? '新增' : '编辑'} · {spec.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {moreFields.length > 0 && onOptionalFieldKeysChange && (
              <button
                onClick={() => setFieldPickerOpen((v) => !v)}
                style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: 'pointer' }}
              >
                字段显示
              </button>
            )}
            <button type="button" data-dialog-initial-focus aria-label="关闭" onClick={requestClose} disabled={busy} style={{ border: 'none', background: 'transparent', fontSize: 'var(--fs-heading)', cursor: busy ? 'not-allowed' : 'pointer', color: 'var(--text-tertiary)', opacity: busy ? 0.6 : 1 }}>×</button>
          </div>
        </div>

        {draftRestoredAt && (
          <div role="status" style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>
            已恢复 {new Date(draftRestoredAt).toLocaleString()} 自动保存的草稿。
          </div>
        )}

        {fieldPickerOpen && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 14, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)' }}>更多信息字段</div>
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {allMoreFields.map((f) => (
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
                deviceBusy={deviceBusy === f.key}
                runDeviceAction={runDeviceAction}
                error={fieldErrors[f.key]}
                hint={optionHint(f, options.length)}
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
                      deviceBusy={deviceBusy === f.key}
                      runDeviceAction={runDeviceAction}
                      error={fieldErrors[f.key]}
                      hint={optionHint(f, options.length)}
                    />
                  );
                })}
              </div>
            )}
          </details>
        )}

        {err && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', marginTop: 12 }}>{err}</div>}

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
              <button onClick={() => setDeleteOpen(true)} disabled={busy} style={{ padding: '9px 16px', borderRadius: 'var(--r-sm)', border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>{deleteLabel}</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={requestClose} disabled={busy} style={{ padding: '9px 18px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)', fontWeight: 'var(--fw-bold)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>取消</button>
            <button onClick={save} disabled={busy} style={{ padding: '9px 18px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 'var(--fw-bold)', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
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
              () => saveFormDraft(draftKey, values, fileValues, entityVersion),
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
  fieldId: string;
  options: FieldOption[];
  value: string;
  selectedValues: string[];
  fileRows: FileRow[];
  set: (key: string, value: string) => void;
  readFiles: (key: string, files: FileList | null) => Promise<void>;
  setFileRows: (key: string, rows: FileRow[]) => void;
  deviceBusy: boolean;
  runDeviceAction: (field: FieldDef) => Promise<void>;
  error?: string;
  hint?: string;
}) {
  const { f, fieldId, options, value, selectedValues, fileRows, set, readFiles, setFileRows, deviceBusy, runDeviceAction, error, hint } = props;
  return (
    <div className="zc-form-field" key={f.key} data-form-field={fieldId} style={{ gridColumn: f.half ? 'span 1' : 'span 2' }}>
      <label className="zc-label" htmlFor={fieldId}>{f.label}{f.required && <span style={{ color: 'var(--negative)', marginLeft: 3 }}>*</span>}</label>
      {f.type === 'select' ? (
        <select id={fieldId} name={f.key} className="zc-select" required={f.required} value={value} onChange={(e) => set(f.key, e.target.value)}>
          {f.allowEmpty && <option value="">（无）</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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
          <input id={fieldId} name={f.key} type="checkbox" checked={value === 'true'} onChange={(e) => set(f.key, e.target.checked ? 'true' : 'false')} />
          启用
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

function splitCategoryLabel(option: FieldOption): { parent: string; child: string } {
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
  fieldId: string;
  name: string;
  value: string;
  options: FieldOption[];
  allowEmpty?: boolean;
  defaultShowHidden?: boolean;
  onChange: (value: string) => void;
  /**
   * 空选项的文案。表单里是“不选择”，筛选场景里是“全部分类”。
   */
  emptyLabel?: string;
  /**
   * 未选择时触发按钮上的文案。没有可见 <label> 的场景（筛选行）用它与空选项保持一致。
   */
  placeholder?: string;
  /**
   * 触发按钮的无障碍名称。表单用 <label htmlFor> 关联，筛选行没有可见标签，
   * 需要显式给一个。
   */
  ariaLabel?: string;
  /**
   * 下拉面板的最小宽度。筛选行里的单元格只有 120px 左右，面板必须能超出触发
   * 按钮的宽度，否则两栏（一级/二级）会被 overflow:hidden 剪掉。
   */
  minPanelWidth?: number;
  /**
   * 让触发按钮的外观与同行的原生 select 对齐（筛选行里混用两种控件）。
   */
  triggerStyle?: CSSProperties;
}) {
  const {
    fieldId, name, value, options, allowEmpty, defaultShowHidden = false, onChange,
    emptyLabel = '不选择', placeholder = '选择分类', ariaLabel, minPanelWidth, triggerStyle,
  } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeParent, setActiveParent] = useState('');
  const [showHidden, setShowHidden] = useState(defaultShowHidden);
  const selected = options.find((option) => option.value === value);
  const selectedParts = selected ? splitCategoryLabel(selected) : undefined;
  const groups = categoryGroups(options, search, value, showHidden);
  const hiddenCount = options.filter((option) => option.hidden && !option.catalogOnly).length;
  const activeGroup = groups.find((group) => group.parent === activeParent)
    ?? groups.find((group) => group.children.some((child) => child.value === value))
    ?? groups[0];
  const parentIndex = activeGroup ? groups.findIndex((group) => group.parent === activeGroup.parent) : 0;

  return (
    <div style={{ position: 'relative' }}>
      <button
        id={fieldId}
        name={name}
        type="button"
        className="zc-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', cursor: 'pointer', minHeight: 38, ...triggerStyle }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>{selectedParts?.parent}</span>
              <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>›</span>
              <b>{selectedParts?.child}</b>
            </>
          ) : placeholder}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          className="zc-category-picker-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: minPanelWidth ? 'auto' : 0,
            ...(minPanelWidth ? { minWidth: minPanelWidth, maxWidth: 'min(96vw, 760px)' } : {}),
            zIndex: 80,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--surface)',
            boxShadow: '0 16px 46px rgba(0,0,0,.18)',
          }}
        >
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <input
              className="zc-input"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="查找分类，输入可搜索隐藏分类"
              style={{ height: 36 }}
            />
            {hiddenCount > 0 && (
              <button
                type="button"
                aria-pressed={showHidden}
                onClick={() => {
                  setShowHidden((current) => !current);
                }}
                style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '0 11px', background: showHidden ? 'var(--accent-soft)' : 'var(--surface)', color: showHidden ? 'var(--accent)' : 'var(--fg-muted)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {showHidden ? '只看高频' : `显示隐藏 (${hiddenCount})`}
              </button>
            )}
          </div>
          <div className="zc-category-picker-grid">
            <div className="zc-category-picker-list" style={{ borderRight: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              {allowEmpty && (
                <button
                  type="button"
                  onClick={() => { onChange(''); setOpen(false); }}
                  style={categoryParentButton(!value)}
                >
                  <span style={categoryDot(0)}>无</span>
                  <span>{emptyLabel}</span>
                </button>
              )}
              {groups.map((group, idx) => (
                <button
                  key={group.parent}
                  type="button"
                  onMouseEnter={() => setActiveParent(group.parent)}
                  onClick={() => setActiveParent(group.parent)}
                  style={categoryParentButton(activeGroup?.parent === group.parent)}
                >
                  <span style={categoryDot(idx)}>{group.parent.slice(0, 1)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.parent}</span>
                </button>
              ))}
              {groups.length === 0 && (
                <div style={{ padding: 14, fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>没有匹配分类</div>
              )}
            </div>
            <div className="zc-category-picker-list" style={{ background: 'var(--surface)' }}>
              {activeGroup?.children.map((option) => {
                const parsed = splitCategoryLabel(option);
                const active = value === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => { onChange(option.value); setOpen(false); setSearch(''); setActiveParent(parsed.parent); }}
                    style={categoryChildButton(active)}
                  >
                    <span style={categoryDot(Math.max(0, parentIndex))}>{parsed.child.slice(0, 1)}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>{parsed.child}</span>
                    {option.catalogOnly
                      ? <span style={categoryHiddenBadge()}>未启用</span>
                      : option.inactive
                        // 停用的分类总是同时被写成 hidden，所以“已停用”要优先于“隐藏”，
                        // 否则用户只看到“隐藏”，会以为开关一下就能找回来。
                        ? <span style={categoryHiddenBadge('inactive')}>已停用</span>
                        : option.hidden && <span style={categoryHiddenBadge()}>隐藏</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_COLORS = ['#f97316', '#8b5cf6', '#0f766e', '#0284c7', '#db2777', '#84cc16', '#64748b', '#dc2626', '#eab308'];

function categoryDot(index: number) {
  return {
    width: 24,
    height: 24,
    borderRadius: 'var(--r-sm)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    color: '#fff',
    background: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    fontSize: 'var(--fs-caption)',
    fontWeight: 'var(--fw-medium)',
  } as const;
}

function categoryParentButton(active: boolean) {
  return {
    width: '100%',
    height: 46,
    border: 'none',
    borderRadius: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 12px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--fg-muted)',
    fontSize: 'var(--fs-body)',
    fontWeight: 'var(--fw-bold)',
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
    height: 46,
    border: 'none',
    borderRadius: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 14px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--fg)',
    fontSize: 'var(--fs-body)',
    fontWeight: 'var(--fw-bold)',
    cursor: 'pointer',
    textAlign: 'left',
  } as const;
}
