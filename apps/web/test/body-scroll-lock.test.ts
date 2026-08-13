import { describe, expect, it } from 'vitest';
import { acquireBodyScrollLock, type BodyScrollTarget } from '../src/ui/body-scroll-lock.js';

function target(overflow = ''): BodyScrollTarget {
  return { style: { overflow } };
}

describe('body scroll lock', () => {
  it('stays locked until nested owners release in parent-first order', () => {
    const body = target('auto');
    const releaseParent = acquireBodyScrollLock(body);
    const releaseChild = acquireBodyScrollLock(body);

    releaseParent();
    expect(body.style.overflow).toBe('hidden');

    releaseChild();
    expect(body.style.overflow).toBe('auto');
  });

  it('restores the original overflow in child-first order', () => {
    const body = target('scroll');
    const releaseParent = acquireBodyScrollLock(body);
    const releaseChild = acquireBodyScrollLock(body);

    releaseChild();
    expect(body.style.overflow).toBe('hidden');

    releaseParent();
    expect(body.style.overflow).toBe('scroll');
  });

  it('ignores duplicate cleanup calls', () => {
    const body = target();
    const release = acquireBodyScrollLock(body);

    release();
    release();

    expect(body.style.overflow).toBe('');
  });
});
