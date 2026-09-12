import { useEffect } from 'react';

export interface BodyScrollTarget {
  style: {
    overflow: string;
  };
}

interface ScrollLockState {
  count: number;
  previousOverflow: string;
}

const scrollLocks = new WeakMap<BodyScrollTarget, ScrollLockState>();

/**
 * Lock one scroll target until every overlapping owner has released it.
 * The release callback is idempotent so React cleanup order cannot leave the
 * page permanently locked when nested dialogs unmount together.
 */
export function acquireBodyScrollLock(target: BodyScrollTarget): () => void {
  let state = scrollLocks.get(target);
  if (!state) {
    state = {
      count: 0,
      previousOverflow: target.style.overflow,
    };
    scrollLocks.set(target, state);
  }
  state.count += 1;
  target.style.overflow = 'hidden';

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = scrollLocks.get(target);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    target.style.overflow = current.previousOverflow;
    scrollLocks.delete(target);
  };
}

export function useBodyScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    // The viewport is the scroller (`html`, not `body`), so locking only <body>
    // would leave the page scrollable behind a modal. Lock both: on document
    // scrollers the root element carries the lock, and <body> covers browsers
    // that still route scrolling through it.
    const releaseRoot = acquireBodyScrollLock(document.documentElement);
    const releaseBody = acquireBodyScrollLock(document.body);
    return () => {
      releaseRoot();
      releaseBody();
    };
  }, [active]);
}
