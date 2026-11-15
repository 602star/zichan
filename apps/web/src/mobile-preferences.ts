import { useSyncExternalStore } from 'react';

export type MobileHomeFocus = 'spending' | 'assets';
const KEY = 'zichan.mobile-home-focus';
const EVENT = 'zichan:mobile-preferences';
let tabFallback: MobileHomeFocus | undefined;
export function readMobileHomeFocus(): MobileHomeFocus {
  if (tabFallback) return tabFallback;
  try { return localStorage.getItem(KEY) === 'assets' ? 'assets' : 'spending'; } catch { return 'spending'; }
}
export function writeMobileHomeFocus(value: MobileHomeFocus) {
  try { localStorage.setItem(KEY, value); tabFallback = undefined; } catch { tabFallback = value; }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', callback);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', callback); };
}
export function useMobileHomeFocus() { return useSyncExternalStore(subscribe, readMobileHomeFocus, () => 'spending' as const); }
