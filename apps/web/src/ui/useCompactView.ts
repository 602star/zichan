import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function snapshot() {
  return window.matchMedia(QUERY).matches;
}

export function useCompactView() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
