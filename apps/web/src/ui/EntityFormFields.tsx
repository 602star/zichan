import { Camera, Paperclip } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { type Category, type Payee } from '@zichan/core';
import { ASSET_PRESETS, ASSET_PRESET_GROUPS, type AssetPresetCode } from '../assetPresets.js';
import { loadAttachmentContent } from '../attachment-content.js';
import { type AttachmentDraftData } from '../db/attachment-storage.js';
import { useStore } from '../db/store.js';
import { barcodeScannerAvailable } from '../device-capabilities.js';
import { sanitizeNumericInput } from '../form-number.js';
import { AttachmentPreview } from './AttachmentPreview.js';
import { CategoryPicker, type FieldOption } from './CategoryPicker.js';
import { ColorFieldInput } from './ColorFieldInput.js';
import { DateTimeInput } from './DateTimeInput.js';
import { categoryIconValue } from './EntityIcon.js';
import { EntityIconEditor } from './EntityIconEditor.js';
import { LocationPicker } from './LocationPicker.js';
import { PayeePicker } from './PayeePicker.js';
import { TagPicker } from './TagPicker.js';
import { ValuePicker } from './ValuePicker.js';

export type FieldType =
  | 'icon'
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'month'
  | 'color'
  | 'select'
  | 'category'
  | 'multiselect'
  | 'tags'
  | 'payee'
  | 'location'
  | 'allocation'
  | 'checkbox'
  | 'textarea'
  | 'file';

export interface FieldDef {
  key: string;
  /** Optional task grouping for compact forms; groups follow first appearance. */
  taskGroup?: string;
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
  /** Read-only context shown beside a value, for example the selected currency beside an amount. */
  suffix?: string | ((values: Record<string, string>) => string);
  defaultValue?: string;
  resetWhen?: string[];
  singleOptionSummary?: boolean;
  /** Offer presets that are added to the ledger only when selected. */
  assetPresetOptions?: boolean;
  checkboxValues?: { checked: string; unchecked: string; label: string };
  half?: boolean; // render at half width (two-column grid)
  /** Auto-grow textarea that starts at one line and blocks bare Enter newlines. */
  singleLine?: boolean;
  section?: 'core' | 'more';
  lockedVisible?: boolean;
  /** Keep a field in 更多信息 even when required or populated. */
  keepInMore?: boolean;
  required?: boolean;
  categoryShowHiddenDefault?: boolean;
  hidden?: boolean;
  visibleWhen?: (values: Record<string, string>) => boolean;
}

export function FormField(props: {
  f: FieldDef;
  compactContext?: boolean;
  values: Record<string, string>;
  fieldId: string;
  options: FieldOption[];
  value: string;
  selectedValues: string[];
  fileRows: AttachmentDraftData[];
  set: (key: string, value: string) => void;
  readFiles: (key: string, files: FileList | null) => Promise<void>;
  setFileRows: (key: string, rows: AttachmentDraftData[]) => void;
  entityId?: string;
  iconDisabled: boolean;
  onIconBusyChange: (busy: boolean) => void;
  deviceBusy: boolean;
  runDeviceAction: (field: FieldDef) => Promise<void>;
  error?: string;
  hint?: string;
  onAddAssetPreset?: (code: AssetPresetCode) => Promise<void>;
  onSuffixClick?: () => void;
  suffixTitle?: string;
  afterControl?: ReactNode;
  fileControl?: ReactNode;
}) {
  const { f, values, fieldId, options, value, selectedValues, fileRows, set, readFiles, setFileRows, deviceBusy, runDeviceAction, error, hint } = props;
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState('');
  const binding = f.payeeBinding;
  const suffix = typeof f.suffix === 'function' ? f.suffix(values) : f.suffix;
  const payeeType = typeof binding?.type === 'function' ? binding.type(values) : binding?.type ?? values[binding?.typeKey ?? 'type'] ?? 'expense';
  const availablePresetGroups = props.onAddAssetPreset ? ASSET_PRESET_GROUPS.map((group) => ({
    label: group.label,
    presets: ASSET_PRESETS.filter((preset) => group.codes.includes(preset.code)
      && !options.some((option) => option.label.trim().toUpperCase() === preset.code)),
  })).filter((group) => group.presets.length > 0) : [];
  const chooseSelect = async (next: string) => {
    const prefix = '__add_asset_preset__:';
    if (!next.startsWith(prefix)) { setPresetError(''); set(f.key, next); return; }
    const preset = ASSET_PRESETS.find((row) => row.code === next.slice(prefix.length));
    if (!preset || !props.onAddAssetPreset) return;
    setPresetBusy(true);
    setPresetError('');
    try { await props.onAddAssetPreset(preset.code); }
    catch (cause) { setPresetError(cause instanceof Error ? cause.message : '添加币种失败，请重试'); }
    finally { setPresetBusy(false); }
  };

  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const hasError = !!(error || presetError);
  const describedBy = [
    error ? errorId : undefined,
    !error && hint ? hintId : undefined,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`zc-form-field${hasError ? ' has-error' : ''}`} key={f.key} data-form-field={fieldId} style={{ gridColumn: f.half ? 'span 1' : 'span 2' }}>
      <label className={props.compactContext ? 'zc-sr-only' : 'zc-label'} htmlFor={fieldId}>{f.type === 'payee' && payeeType === 'income' ? '付款方' : f.label}{f.required && <span style={{ color: 'var(--negative)', marginLeft: 3 }}>*</span>}</label>
      {f.type === 'select' && f.singleOptionSummary && options.length === 1 ? <output id={fieldId} aria-label={f.label} style={{ display: 'block', padding: '8px 0' }}>{options[0]!.label}</output> : f.type === 'select' ? (
        <ValuePicker id={fieldId} name={f.key} label={f.label} required={f.required} disabled={presetBusy} invalid={hasError} describedBy={describedBy} value={value} onChange={(next) => void chooseSelect(next)} options={[
          ...(f.allowEmpty ? [{ value: '', label: '（无）' }] : []),
          ...options.map((option) => ({ value: option.value, label: option.label, group: option.groupName })),
          ...availablePresetGroups.flatMap((group) => group.presets.map((preset) => ({ value: `__add_asset_preset__:${preset.code}`, label: `${preset.code} · ${preset.name}`, group: `添加${group.label}` }))),
        ]} />
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
          invalid={hasError}
          describedBy={describedBy}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'color' ? (
        <ColorFieldInput
          id={fieldId}
          name={f.key}
          value={value}
          placeholder={f.placeholder}
          required={f.required}
          invalid={hasError}
          describedBy={describedBy}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'month' ? (
        <input
          id={fieldId}
          name={f.key}
          className="zc-input"
          type="month"
          value={value}
          placeholder={f.placeholder ?? 'YYYY-MM'}
          onChange={(e) => set(f.key, e.target.value)}
          required={f.required}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
        />
      ) : f.type === 'payee' ? (
        <PayeePicker id={fieldId} payees={f.payees ?? []} categories={f.categories ?? []} payeeId={binding?.textOnly ? '' : value} merchant={values[binding?.nameKey ?? 'merchant'] ?? ''} categoryId={values[binding?.categoryKey ?? 'category'] ?? ''} type={payeeType} textOnly={binding?.textOnly} onChange={(id, name) => { if (!binding?.textOnly) set(f.key, id); set(binding?.nameKey ?? 'merchant', name); }} />
      ) : f.type === 'location' ? (
        <LocationPicker id={fieldId} options={options} locationId={value} name={values.locationName ?? ''}
          onChange={(id, name) => { set(f.key, id); set('locationName', name); }}
          deviceBusy={deviceBusy} onLocate={() => void runDeviceAction(f)} />
      ) : f.type === 'tags' ? (
        <TagPicker id={fieldId} options={options} value={value} onChange={(next) => set(f.key, next)} />
      ) : f.type === 'multiselect' ? (
        <MultiSelectChips
          id={fieldId}
          label={f.label}
          options={options}
          selectedValues={selectedValues}
          invalid={hasError}
          describedBy={describedBy}
          onChange={(next) => set(f.key, next.join(','))}
        />
      ) : f.type === 'allocation' ? (
        <AllocationEditor
          fieldId={fieldId}
          options={options}
          value={value}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-body)', color: 'var(--text-primary)', paddingTop: 4, minHeight: 36 }}>
          <input id={fieldId} name={f.key} type="checkbox" aria-label={f.label} aria-invalid={hasError || undefined} aria-describedby={describedBy} checked={value === (f.checkboxValues?.checked ?? 'true')} onChange={(e) => set(f.key, e.target.checked ? (f.checkboxValues?.checked ?? 'true') : (f.checkboxValues?.unchecked ?? 'false'))} />
          {f.checkboxValues?.label ?? '启用'}
        </label>
      ) : f.type === 'textarea' ? (
        <AutoGrowTextarea
          id={fieldId}
          name={f.key}
          value={value}
          placeholder={f.placeholder}
          singleLine={f.singleLine}
          required={f.required}
          invalid={hasError}
          describedBy={describedBy}
          onChange={(next) => set(f.key, next)}
        />
      ) : f.type === 'file' && props.fileControl ? props.fileControl : f.type === 'file' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="zc-attachment-dropzone-row">
            <label className="zc-attachment-dropzone" htmlFor={fieldId}>
              <input
                id={fieldId}
                name={f.key}
                className="zc-sr-only"
                type="file"
                accept={f.accept}
                multiple={f.multiple !== false}
                onChange={(e) => { const input = e.currentTarget; void readFiles(f.key, input.files).finally(() => { input.value = ''; }); }}
                required={f.required}
                aria-invalid={hasError || undefined}
                aria-describedby={describedBy}
              />
              <Paperclip size={16} aria-hidden="true" />
              <span className="zc-attachment-dropzone-main">{fileRows.length > 0 ? `已选 ${fileRows.length} 个文件 · 继续添加` : '选择文件或图片'}</span>
            </label>
            {f.capture && (
              <label className="zc-btn zc-touch-only zc-attachment-camera-btn" htmlFor={`${fieldId}-camera`} title="使用相机拍照">
                <Camera size={16} aria-hidden="true" />
                <span>拍照</span>
                <input id={`${fieldId}-camera`} className="zc-sr-only" type="file" accept="image/*" capture={f.capture} onChange={(e) => { const input = e.currentTarget; void readFiles(f.key, input.files).finally(() => { input.value = ''; }); }} />
              </label>
            )}
          </div>
          {fileRows.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {fileRows.map((row, idx) => (
                <div key={`${row.fileName}:${idx}`} className="zc-attachment-thumb-card">
                  <AttachmentPreview attachment={row} interactive alt={row.fileName} style={{ width: 74, height: 54, objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3 }}>{row.fileName}</div>
                  {row.sizeBytes && <div>{row.sizeBytes > 1024 * 1024 ? `${(row.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`}</div>}
                  <div className="zc-attachment-thumb-actions">
                    <AttachmentSaveButton attachment={row} />
                    <button
                      type="button"
                      className="zc-attachment-remove-btn"
                      title="移除附件"
                      aria-label={`移除 ${row.fileName}`}
                      onClick={() => setFileRows(f.key, fileRows.filter((_, rowIndex) => rowIndex !== idx))}
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : f.type === 'date' || f.type === 'time' ? (
        <DateTimeInput id={fieldId} name={f.key} className="zc-input" type={f.type} value={value}
          aria-label={f.label} aria-invalid={hasError || undefined} aria-describedby={describedBy} onChange={(next) => set(f.key, next)} required={f.required} />
      ) : (
        <div className={`zc-input-with-suffix${f.key === 'amount' ? ' is-amount' : ''}`}>
          <ImeTextInput
            id={fieldId}
            name={f.key}
            numeric={f.type === 'number'}
            value={value}
            placeholder={f.placeholder}
            required={f.required}
            invalid={hasError}
            describedBy={describedBy}
            onChange={(next) => set(f.key, next)}
          />
          {suffix && (props.onSuffixClick ? (
            <button
              type="button"
              className="zc-amount-currency zc-amount-currency-btn"
              aria-label={`当前币种：${suffix}，点击切换`}
              title={props.suffixTitle ?? '点击切换币种'}
              onClick={props.onSuffixClick}
            >
              {suffix}
            </button>
          ) : (
            <output className="zc-amount-currency" aria-label="当前币种">{suffix}</output>
          ))}
          {f.deviceAction && (f.deviceAction !== 'scan-barcode' || barcodeScannerAvailable()) && (
            <button type="button" title={f.deviceAction === 'scan-barcode' ? '扫描条形码或二维码' : '读取当前位置'} disabled={deviceBusy} onClick={() => void runDeviceAction(f)} style={{ flex: '0 0 auto', minHeight: 40, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text-secondary)', background: 'var(--surface-2)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', cursor: deviceBusy ? 'wait' : 'pointer' }}>
              {deviceBusy ? '读取中…' : f.deviceAction === 'scan-barcode' ? '扫码' : '定位'}
            </button>
          )}
        </div>
      )}
      {error && <div id={errorId} className="zc-entry-field-error" role="alert">{error}</div>}
      {presetError && <div role="alert" className="zc-entry-field-error">{presetError}</div>}
      {!error && hint && <div id={hintId} className="zc-field-hint">{hint}</div>}
      {props.afterControl}
    </div>
  );
}

function AutoGrowTextarea({
  id,
  name,
  value,
  placeholder,
  singleLine = false,
  required,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  placeholder?: string;
  singleLine?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const minH = singleLine ? 40 : 88;
    const maxH = singleLine ? 180 : 320;
    const next = Math.max(minH, Math.min(el.scrollHeight + 2, maxH));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  };

  useLayoutEffect(resize, [draft, singleLine]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = Math.round(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width);
      if (width > 0 && width !== lastWidth) {
        lastWidth = width;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [singleLine]); // eslint-disable-line react-hooks/exhaustive-deps

  const normalize = (text: string) => (singleLine ? text.replace(/[\r\n]+/g, ' ') : text);

  return (
    <textarea
      ref={ref}
      id={id}
      name={name}
      rows={singleLine ? 1 : 3}
      className={`zc-input zc-autogrow-textarea${singleLine ? ' is-single-line' : ''}`}
      value={draft}
      placeholder={placeholder}
      required={required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => {
        composing.current = false;
        const next = normalize(event.currentTarget.value);
        setDraft(next);
        onChange(next);
      }}
      onChange={(event) => {
        const raw = event.target.value;
        if (composing.current || (event.nativeEvent as InputEvent).isComposing) {
          setDraft(raw);
          return;
        }
        const next = normalize(raw);
        setDraft(next);
        onChange(next);
      }}
      onBlur={() => {
        if (composing.current) {
          composing.current = false;
          const next = normalize(draft);
          setDraft(next);
          if (next !== value) onChange(next);
        }
      }}
      onKeyDown={singleLine ? (event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
        }
      } : undefined}
    />
  );
}

function ImeTextInput({
  id,
  name,
  numeric,
  value,
  placeholder,
  required,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  name: string;
  numeric: boolean;
  value: string;
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (next: string) => void;
}) {
  const composing = useRef(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);

  return (
    <input
      id={id}
      name={name}
      className="zc-input"
      type="text"
      inputMode={numeric ? 'decimal' : undefined}
      value={draft}
      placeholder={placeholder}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => {
        composing.current = false;
        const next = event.currentTarget.value;
        setDraft(next);
        onChange(next);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
        onChange(next);
      }}
      onBlur={(event) => {
        composing.current = false;
        const raw = event.target.value;
        const next = numeric ? sanitizeNumericInput(raw) : raw;
        setDraft(next);
        if (next !== value) onChange(next);
      }}
      required={required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      style={{ flex: 1, minWidth: 0 }}
    />
  );
}

function MultiSelectChips({
  id,
  label,
  options,
  selectedValues,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  options: FieldOption[];
  selectedValues: string[];
  invalid?: boolean;
  describedBy?: string;
  onChange: (next: string[]) => void;
}) {
  const toggle = (val: string) => {
    const next = selectedValues.includes(val)
      ? selectedValues.filter((item) => item !== val)
      : [...selectedValues, val];
    onChange(next);
  };
  if (!options.length) {
    return <div id={id} className="zc-caption" aria-describedby={describedBy}>暂无可选项</div>;
  }
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="zc-multiselect-chips"
    >
      {options.map((option) => {
        const checked = selectedValues.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`zc-multiselect-chip${checked ? ' is-selected' : ''}`}
            aria-pressed={checked}
            onClick={() => toggle(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AllocationEditor(props: {
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
          <input
            className="zc-input"
            inputMode="decimal"
            value={values[option.value] ?? ''}
            onChange={(event) => update(option.value, event.target.value)}
            onBlur={(event) => {
              const cleaned = sanitizeNumericInput(event.target.value);
              if (cleaned !== event.target.value) update(option.value, cleaned);
            }}
            placeholder="退款金额"
          />
        </label>
      ))}
    </div>
  );
}

export function AttachmentSaveButton({ attachment }: { attachment: AttachmentDraftData }) {
  const { store, downloadPreviewAttachment } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const blob = await loadAttachmentContent(store, attachment, downloadPreviewAttachment);
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
      aria-label={`保存 ${attachment.fileName}`}
      onClick={() => void save()}
      disabled={busy}
      className={`zc-attachment-link-btn${error ? ' is-error' : ''}`}
    >
      {busy ? '取回中…' : error ? '重试' : '保存'}
    </button>
  );
}
