import { useEffect, useState } from 'react';
import { accountSessionStorage } from './account-storage.js';
import type { ScreenId } from './navigationPreferences.js';

export interface ScreenTarget { screen: ScreenId; tab?: string; id?: string; }
const key = (screen: string) => `zichan.screen-target.${screen}`;

export function rememberScreenTarget(target: ScreenTarget) {
  try { accountSessionStorage.setItem(key(target.screen), JSON.stringify(target)); } catch { /* Live navigation remains available. */ }
}
export function navigateTo(target: ScreenTarget) {
  rememberScreenTarget(target);
  if (target.screen === 'transactions' && target.tab) {
    try { accountSessionStorage.setItem('zichan.transactions.tab', target.tab); } catch { /* Live target below. */ }
  }
  window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: target }));
}
export function useScreenTarget(screen: ScreenId) {
  const [target, setTarget] = useState<ScreenTarget | null>(() => {
    try { return JSON.parse(accountSessionStorage.getItem(key(screen)) ?? 'null') as ScreenTarget | null; } catch { return null; }
  });
  useEffect(() => {
    try { accountSessionStorage.removeItem(key(screen)); } catch { /* Hardened browser. */ }
    const update = (event: Event) => {
      const next = (event as CustomEvent<ScreenTarget>).detail;
      if (next?.screen === screen) {
        setTarget(next);
        queueMicrotask(() => {
          try { accountSessionStorage.removeItem(key(screen)); } catch { /* Hardened browser. */ }
        });
      }
    };
    window.addEventListener('zichan:screen-target', update);
    return () => window.removeEventListener('zichan:screen-target', update);
  }, [screen]);
  return target;
}
