import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useBodyScrollLock } from './body-scroll-lock.js';

const DialogLayerContext = createContext(40);

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('[hidden], [inert]')) return false;
    return element.tabIndex >= 0;
  });
}

/** Pure focus-wrap decision used by the keyboard contract and unit tests. */
export function wrappedDialogFocusIndex(index: number, length: number, backwards: boolean): number | null {
  if (length <= 0) return null;
  if (index < 0) return backwards ? length - 1 : 0;
  if (backwards && index === 0) return length - 1;
  if (!backwards && index === length - 1) return 0;
  return null;
}

export function dialogTabTarget(
  index: number,
  length: number,
  backwards: boolean,
): number | 'panel' | null {
  if (length <= 0) return 'panel';
  return wrappedDialogFocusIndex(index, length, backwards);
}

export function shouldDismissDialog(
  key: string,
  closeOnEscape: boolean,
  hasDismissHandler: boolean,
  dismissDisabled: boolean,
): boolean {
  return key === 'Escape' && closeOnEscape && hasDismissHandler && !dismissDisabled;
}

/**
 * Restoring focus to the page is safe only when no dialog remains. A nested
 * dialog may restore to an element inside its still-open parent, while a dialog
 * replaced by another dialog must not move focus behind the new top layer.
 */
export function shouldRestoreDialogFocus(
  target: Node,
  activeDialogRoots: readonly Pick<Node, 'contains'>[],
): boolean {
  return activeDialogRoots.length === 0
    || activeDialogRoots.some((root) => root.contains(target));
}

export interface DialogShellProps {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  onDismiss?: () => void;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  dismissDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  backdropClassName?: string;
  panelClassName?: string;
  backdropStyle?: CSSProperties;
  panelStyle?: CSSProperties;
}

/**
 * Shared modal foundation. Dialogs render into the app's themed portal host so
 * they are not clipped by page overflow, while React's tree still preserves
 * nested dialog ownership. Focus is trapped per physical panel, which keeps a
 * child portal from also triggering its parent's keyboard handler.
 */
export function DialogShell({
  children,
  labelledBy,
  describedBy,
  onDismiss,
  closeOnEscape = true,
  closeOnBackdrop = true,
  dismissDisabled = false,
  initialFocusRef,
  backdropClassName = 'zc-backdrop',
  panelClassName,
  backdropStyle,
  panelStyle,
}: DialogShellProps) {
  const parentLayer = useContext(DialogLayerContext);
  const requestedLayer = typeof backdropStyle?.zIndex === 'number' ? backdropStyle.zIndex : 50;
  const layer = Math.max(parentLayer + 10, requestedLayer);
  const dialogId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const focusGenerationRef = useRef(0);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() => (
    typeof document === 'undefined' ? null : document.getElementById('zc-dialog-portal')
  ));
  const restoreFocusRef = useRef<HTMLElement | null | undefined>(undefined);

  if (restoreFocusRef.current === undefined && typeof document !== 'undefined') {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useBodyScrollLock();

  useLayoutEffect(() => {
    if (!portalTarget) setPortalTarget(document.getElementById('zc-dialog-portal') ?? document.body);
  }, [portalTarget]);

  useLayoutEffect(() => {
    const generation = focusGenerationRef.current + 1;
    focusGenerationRef.current = generation;
    const panel = panelRef.current;
    if (!panel) return undefined;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !panel.contains(active)) {
      const preferred = initialFocusRef?.current
        ?? panel.querySelector<HTMLElement>('[data-dialog-initial-focus]')
        ?? focusableElements(panel)[0]
        ?? panel;
      preferred.focus({ preventScroll: true });
    }
    const restoreFocus = restoreFocusRef.current;
    return () => {
      if (!restoreFocus) return;
      queueMicrotask(() => {
        if (focusGenerationRef.current !== generation || !restoreFocus.isConnected) return;
        const activeDialogRoots = [...document.querySelectorAll<HTMLElement>('[data-zc-dialog-root]')];
        if (shouldRestoreDialogFocus(restoreFocus, activeDialogRoots)) {
          restoreFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [initialFocusRef, portalTarget]);

  useLayoutEffect(() => {
    if (!dismissDisabled) return;
    const panel = panelRef.current;
    if (panel && focusableElements(panel).length === 0 && document.activeElement !== panel) {
      panel.focus({ preventScroll: true });
    }
  }, [dismissDisabled]);

  function dismiss() {
    if (!dismissDisabled) onDismiss?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
    if (event.key === 'Escape') {
      if (shouldDismissDialog(event.key, closeOnEscape, !!onDismiss, dismissDisabled)) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = focusableElements(panel);
    const currentIndex = document.activeElement instanceof HTMLElement
      ? focusables.indexOf(document.activeElement)
      : -1;
    const target = dialogTabTarget(currentIndex, focusables.length, event.shiftKey);
    if (target === null) return;
    event.preventDefault();
    (target === 'panel' ? panel : focusables[target] ?? panel).focus({ preventScroll: true });
  }

  if (!portalTarget) return null;
  return createPortal(
    <DialogLayerContext.Provider value={layer}>
      <div
        className={backdropClassName}
        data-zc-dialog-root={dialogId}
        style={{ ...backdropStyle, zIndex: layer }}
        onClick={(event) => {
          if (event.target === event.currentTarget && closeOnBackdrop && onDismiss) dismiss();
        }}
      >
        <div
          ref={panelRef}
          className={panelClassName}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          tabIndex={-1}
          style={panelStyle}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </div>
    </DialogLayerContext.Provider>,
    portalTarget,
  );
}
