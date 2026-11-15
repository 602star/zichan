import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

const HOLD_MS = 500;
const MOVE_TOLERANCE = 10;
const SWIPE_DISTANCE = 56;
const EDGE_GUARD = 24;
const INTERACTIVE = 'button, input, select, textarea, a, label, summary, [role="button"]';

interface Gesture {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  horizontal: boolean;
}

/** Touch-only shortcuts. Vertical scrolling, zooming and system edge-back keep ownership. */
export function useRecordGestures(onOpen: (id: string) => void, enabled: boolean) {
  const gesture = useRef<Gesture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const suppressed = useRef<{ id: string; until: number } | null>(null);
  const consumeReleaseClick = useRef(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const [preview, setPreview] = useState<{ id: string; direction: 'left' | 'right' } | null>(null);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    gesture.current = null;
    setPreview(null);
  }, []);

  function open(id: string) {
    suppressed.current = { id, until: Date.now() + 800 };
    consumeReleaseClick.current = true;
    cancel();
    openRef.current(id);
  }

  useEffect(() => {
    const stop = () => cancel();
    const anotherFinger = (event: PointerEvent) => {
      if (!event.isPrimary) cancel();
      else {
        consumeReleaseClick.current = false;
        suppressed.current = null;
      }
    };
    // A hold opens a portal while the finger is still down. Its release click can
    // be retargeted to the new backdrop, so consuming it on the row is too late.
    const releaseClick = (event: MouseEvent) => {
      if (!consumeReleaseClick.current || event.detail === 0) return;
      consumeReleaseClick.current = false;
      suppressed.current = null;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('scroll', stop, true);
    window.addEventListener('blur', stop);
    window.addEventListener('pointerdown', anotherFinger, true);
    window.addEventListener('click', releaseClick, true);
    return () => {
      clearTimeout(timer.current);
      gesture.current = null;
      window.removeEventListener('scroll', stop, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('pointerdown', anotherFinger, true);
      window.removeEventListener('click', releaseClick, true);
    };
  }, [cancel]);

  useEffect(() => { if (!enabled) cancel(); }, [enabled, cancel]);

  function isInteractive(target: EventTarget) {
    return target instanceof Element && !!target.closest(INTERACTIVE);
  }

  return {
    preview,
    bind(id: string) {
      return {
        onPointerDown(event: ReactPointerEvent<HTMLTableRowElement>) {
          // A second finger cancels the hold rather than opening a sheet during a pinch.
          if (!event.isPrimary) { cancel(); return; }
          if (!enabled || event.pointerType === 'mouse' || isInteractive(event.target)) return;
          cancel();
          if (event.clientX < EDGE_GUARD || event.clientX > window.innerWidth - EDGE_GUARD) return;
          gesture.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, horizontal: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          timer.current = setTimeout(() => { if (gesture.current?.id === id) open(id); }, HOLD_MS);
        },
        onPointerMove(event: ReactPointerEvent<HTMLTableRowElement>) {
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const dx = event.clientX - active.x;
          const dy = event.clientY - active.y;
          if (Math.abs(dy) > MOVE_TOLERANCE && (!active.horizontal || Math.abs(dy) > Math.abs(dx))) { cancel(); return; }
          if (Math.abs(dx) > MOVE_TOLERANCE) {
            clearTimeout(timer.current);
            if (Math.abs(dx) > Math.abs(dy) * 1.5) active.horizontal = true;
          }
          active.dx = dx;
          if (active.horizontal) setPreview({ id, direction: dx < 0 ? 'left' : 'right' });
        },
        onPointerUp(event: ReactPointerEvent<HTMLTableRowElement>) {
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          if (active.horizontal) {
            // Even a short swipe must not turn into a synthetic row click.
            suppressed.current = { id, until: Date.now() + 800 };
            if (Math.abs(active.dx) >= SWIPE_DISTANCE) { open(id); return; }
          }
          cancel();
        },
        onPointerCancel: cancel,
        onLostPointerCapture: cancel,
        onClickCapture(event: ReactMouseEvent<HTMLTableRowElement>) {
          if (suppressed.current?.id === id && Date.now() < suppressed.current.until && !isInteractive(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            suppressed.current = null;
          }
        },
        onContextMenu(event: ReactMouseEvent<HTMLTableRowElement>) {
          if (!enabled || isInteractive(event.target)) return;
          event.preventDefault();
          if (suppressed.current?.id !== id || Date.now() >= suppressed.current.until) open(id);
        },
      };
    },
  };
}
