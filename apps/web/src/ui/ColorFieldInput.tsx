import { X } from 'lucide-react';

const PRESET_SWATCHES = [
  { hex: '#b63226', name: '朱赤' },
  { hex: '#2b6079', name: '靛蓝' },
  { hex: '#76531c', name: '黄土' },
  { hex: '#3d6b52', name: '松绿' },
  { hex: '#7c4d6b', name: '紫檀' },
  { hex: '#c26d2d', name: '琥珀' },
  { hex: '#4a5568', name: '青墨' },
  { hex: '#14b8a6', name: '青碧' },
];

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function toSixDigitHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#b63226';
}

export function ColorFieldInput({
  id,
  name,
  value,
  placeholder,
  required,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const pickerValue = HEX_COLOR.test(value.trim()) ? toSixDigitHex(value) : '#b63226';
  const normalized = value.trim().toLowerCase();

  return (
    <div className="zc-color-field">
      <div className="zc-color-input-row">
        <label className="zc-color-swatch-picker" title="选择自定义颜色">
          <input
            type="color"
            aria-label="取色器"
            value={pickerValue}
            onChange={(event) => onChange(event.target.value)}
          />
          <span
            className="zc-color-swatch-preview"
            style={{ background: HEX_COLOR.test(value.trim()) ? value.trim() : 'transparent' }}
            aria-hidden="true"
          />
        </label>
        <input
          id={id}
          name={name}
          className="zc-input"
          type="text"
          value={value}
          placeholder={placeholder ?? '#b63226'}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        {value && (
          <button
            type="button"
            className="zc-btn zc-color-clear"
            aria-label="清除颜色"
            title="清除颜色"
            onClick={() => onChange('')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="zc-color-presets" role="group" aria-label="常用颜色">
        {PRESET_SWATCHES.map((swatch) => {
          const active = normalized === swatch.hex;
          return (
            <button
              key={swatch.hex}
              type="button"
              className={`zc-color-preset${active ? ' is-selected' : ''}`}
              aria-label={`选择${swatch.name} (${swatch.hex})`}
              aria-pressed={active}
              title={`${swatch.name} ${swatch.hex}`}
              onClick={() => onChange(swatch.hex)}
            >
              <span style={{ background: swatch.hex }} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
