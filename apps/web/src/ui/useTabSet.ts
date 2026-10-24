import { useId, type KeyboardEvent } from 'react';

type TabKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function nextTabValue<T extends string>(items: readonly T[], current: T, key: TabKey): T | null {
  if (items.length === 0) return null;
  const index = items.indexOf(current);
  if (key === 'Home') return items[0] ?? null;
  if (key === 'End') return items[items.length - 1] ?? null;
  if (key === 'ArrowRight') return items[(index + 1) % items.length] ?? null;
  return items[(index - 1 + items.length) % items.length] ?? null;
}

/** Automatic-activation tabs with one roving tab stop and a shared current panel. */
export function useTabSet<T extends string>(items: readonly T[], selected: T, onSelect: (item: T) => void) {
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (item: T) => `${baseId}-tab-${items.indexOf(item)}`;

  function tabProps(item: T) {
    return {
      id: tabId(item),
      role: 'tab' as const,
      'aria-selected': selected === item,
      'aria-controls': panelId,
      tabIndex: selected === item ? 0 : -1,
      onClick: () => onSelect(item),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = nextTabValue(items, item, event.key as TabKey);
        if (!next) return;
        onSelect(next);
        document.getElementById(tabId(next))?.focus();
      },
    };
  }

  return {
    tabProps,
    panelProps: {
      id: panelId,
      role: 'tabpanel' as const,
      'aria-labelledby': tabId(selected),
      tabIndex: 0,
    },
  };
}
