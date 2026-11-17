import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeOnboarding, readOnboarding, resumeOnboarding, startOnboarding, updateOnboarding } from '../src/onboarding.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('新手指南重新打开与旧进度兼容', () => {
  it('distinguishes completing the guide from temporarily dismissing it', () => {
    const state = updateOnboarding(startOnboarding('a', 'spending'), { dismissed: true });
    expect(readOnboarding('a')?.completed).not.toBe(true);
    const completed = completeOnboarding(state);
    expect(readOnboarding('a')).toEqual({ ...state, dismissed: true, completed: true });
    expect(resumeOnboarding('a', 'accounts')).toEqual({ ...completed, dismissed: false });
    expect(completeOnboarding(readOnboarding('a')!)).toEqual(completed);
  });
  it('resumes completed steps without resetting the selected path or mobile position', () => {
    const state = updateOnboarding(startOnboarding('a', 'accounts'), { dismissed: true, firstTransactionRecorded: true, categorySkipped: true, templateUsed: true, mobileStep: 3 });
    expect(resumeOnboarding('a', 'spending')).toEqual({ ...state, dismissed: false });
    expect(readOnboarding('a')?.mobileStep).toBe(3);
  });
  it('starts a guide for an existing ledger and keeps different ledgers separate', () => {
    resumeOnboarding('a', 'spending', true);
    const b = resumeOnboarding('b', 'accounts', false);
    expect(readOnboarding('a')).toMatchObject({ firstTransactionRecorded: true, path: 'spending' });
    expect(b).toMatchObject({ firstTransactionRecorded: false, path: 'accounts', dismissed: false });
  });
  it('reads a matching legacy guide and preserves its progress when upgrading storage', () => {
    const legacy = { settingId: 'old', path: 'accounts', dismissed: true, firstTransactionRecorded: true, categorySkipped: false, templateUsed: false, mobileStep: 2 };
    localStorage.setItem('zichan.onboarding.v1', JSON.stringify(legacy));
    expect(readOnboarding('other')).toBeNull();
    expect(resumeOnboarding('old', 'spending')).toEqual({ ...legacy, dismissed: false });
    startOnboarding('new', 'spending');
    expect(readOnboarding('old')).toMatchObject({ path: 'accounts', mobileStep: 2 });
  });
});
