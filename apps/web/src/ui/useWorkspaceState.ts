import { useEffect, useState, type SetStateAction, type Dispatch } from 'react';
import { accountStorageKey } from '../account-storage.js';

// View state only: account/replica-scoped and deliberately lost on reload.
const views = new Map<string, unknown>();

export function useWorkspaceState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const scoped = accountStorageKey(`workspace.${key}`);
  const [value, setValue] = useState<T>(() => views.has(scoped)
    ? views.get(scoped) as T
    : typeof initial === 'function' ? (initial as () => T)() : initial);
  useEffect(() => { views.set(scoped, value); }, [scoped, value]);
  return [value, setValue];
}
