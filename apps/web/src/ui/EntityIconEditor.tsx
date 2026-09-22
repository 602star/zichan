import { useRef, useState, useEffect } from 'react';
import { readEntityIcon } from '../entity-icon-upload.js';
import { EntityIcon, ENTITY_ICONS } from './EntityIcon.js';
import { btnOutline } from './styles.js';

export function EntityIconEditor({ id, value, defaultIcon, platformName, platformId, disabled = false, onChange, onBusyChange }: {
  id: string; value: string; defaultIcon?: string; platformName?: string; platformId?: string;
  disabled?: boolean;
  onChange: (value: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <div>
    <div className="zc-icon-editor-actions">
      <span className="zc-icon-preview" aria-label="图标预览"><EntityIcon icon={value || defaultIcon} platformName={platformName} platformId={platformId} fallback="store" size={28} /></span>
      <button id={id} type="button" style={btnOutline} disabled={busy || disabled} onClick={() => input.current?.click()}>{busy ? '处理图片…' : '上传图片'}</button>
      <button type="button" style={btnOutline} disabled={busy || disabled || !value} onClick={() => { setError(''); onChange(''); }}>恢复默认图标</button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传自定义图标" hidden disabled={busy || disabled}
        onChange={async (event) => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (!file) return;
          setBusy(true); onBusyChange(true); setError('');
          try { const next = await readEntityIcon(file); if (alive.current) onChange(next); }
          catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '图片处理失败'); }
          finally { if (alive.current) { setBusy(false); onBusyChange(false); } }
        }} />
    </div>
    <p className="zc-meta">PNG、JPG、WebP，最大 2 MB；自动缩小并保留完整图片，保存后随账本同步。</p>
    <details><summary>选择内置图标</summary><div className="zc-icon-options">
      {Object.entries(ENTITY_ICONS).map(([key, item]) => <button type="button" key={key} title={item.label} aria-label={`图标：${item.label}`}
        aria-pressed={value === `lucide:${key}`} disabled={busy || disabled} onClick={() => { setError(''); onChange(`lucide:${key}`); }}>
        <EntityIcon icon={`lucide:${key}`} />
      </button>)}
    </div></details>
    {error && <p role="alert" className="zc-icon-error">{error}</p>}
  </div>;
}
