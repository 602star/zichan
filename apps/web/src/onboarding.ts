import { accountLocalStorage } from './account-storage.js';

const KEY = 'zichan.onboarding.v1';

export interface OnboardingState {
  settingId: string;
  path: 'spending' | 'accounts';
  dismissed: boolean;
  firstTransactionRecorded: boolean;
  categorySkipped: boolean;
  templateUsed: boolean;
  mobileStep?: number;
}

export function readOnboarding(settingId: string): OnboardingState | null {
  try {
    const value = JSON.parse(accountLocalStorage.getItem(KEY) ?? 'null') as OnboardingState | null;
    return value?.settingId === settingId && (value.path === 'spending' || value.path === 'accounts') ? value : null;
  } catch {
    return null;
  }
}

export function startOnboarding(settingId: string, path: OnboardingState['path']): void {
  try {
    accountLocalStorage.setItem(KEY, JSON.stringify({
      settingId, path, dismissed: false, firstTransactionRecorded: false,
      categorySkipped: false, templateUsed: false, mobileStep: 0,
    } satisfies OnboardingState));
  } catch {
    // A private browser may reject storage; ledger creation must still work.
  }
}

export function updateOnboarding(state: OnboardingState, changes: Partial<OnboardingState>): OnboardingState {
  const next = { ...state, ...changes };
  try { accountLocalStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Keep the in-memory guide usable. */ }
  return next;
}
