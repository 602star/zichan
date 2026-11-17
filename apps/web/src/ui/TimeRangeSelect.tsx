import type { CSSProperties } from 'react';

/** One compact preset control, with options supplied by the query's own time semantics. */
export function TimeRangeSelect({ value, onChange, options, label = '快捷时间范围', className = '', style }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return <select aria-label={label} className={`zc-select ${className}`.trim()} value={value}
    onChange={(event) => onChange(event.target.value)} style={{ width: 'var(--date-preset-w, 128px)', maxWidth: '100%', ...style }}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
