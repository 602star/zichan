import { accountLocalStorage } from './account-storage.js';

const KEY = 'zichan.onboarding.v1';
export const ONBOARDING_CHANGED_EVENT = 'zichan:onboarding-changed';

export interface OnboardingState {
  settingId: string;
  path: 'spending' | 'accounts';
  dismissed: boolean;
  completed?: boolean;
  firstTransactionRecorded: boolean;
  categorySkipped: boolean;
  templateUsed: boolean;
  mobileStep?: number;
}

export function readOnboarding(settingId: string): OnboardingState | null {
  try {
    const value = JSON.parse(accountLocalStorage.getItem(`${KEY}.${settingId}`) ?? accountLocalStorage.getItem(KEY) ?? 'null') as OnboardingState | null;
    return value?.settingId === settingId && (value.path === 'spending' || value.path === 'accounts') ? value : null;
  } catch {
    return null;
  }
}

function writeOnboarding(state: OnboardingState): OnboardingState {
  try {
    accountLocalStorage.setItem(`${KEY}.${state.settingId}`, JSON.stringify(state));
  } catch {
    // A private browser may reject storage; ledger creation must still work.
  }
  if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    const event = new CustomEvent(ONBOARDING_CHANGED_EVENT, { detail: state });
    queueMicrotask(() => globalThis.dispatchEvent?.(event));
  }
  return state;
}

export function startOnboarding(settingId: string, path: OnboardingState['path']): OnboardingState {
  return writeOnboarding({ settingId, path, dismissed: false, firstTransactionRecorded: false,
    categorySkipped: false, templateUsed: false, mobileStep: 0 });
}

export function resumeOnboarding(settingId: string, path: OnboardingState['path'], firstTransactionRecorded = false): OnboardingState {
  const current = readOnboarding(settingId);
  return current ? updateOnboarding(current, { dismissed: false })
    : updateOnboarding(startOnboarding(settingId, path), { firstTransactionRecorded });
}

export function completeOnboarding(state: OnboardingState): OnboardingState {
  return updateOnboarding(state, { completed: true, dismissed: true });
}

export function updateOnboarding(state: OnboardingState, changes: Partial<OnboardingState>): OnboardingState {
  const next = { ...state, ...changes };
  return writeOnboarding(next);
}
