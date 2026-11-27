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
import { useMobileDialogHistory } from './mobile-dialog-history.js';

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

const FORM_INPUT_SELECTOR = [
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('[hidden], [inert]')) return false;
    return element.tabIndex >= 0;
  });
}

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Pick the initial focus element when a dialog mounts:
 * 1. Explicit `initialFocusRef` or `[data-dialog-initial-focus]`.
 * 2. On fine pointers (desktop), prefer the first editable field inside the
 *    dialog body so typing starts right away instead of landing on the close X.
 * 3. On coarse pointers (touch), avoid auto-opening the soft keyboard by
 *    preferring the first non-input control, or the panel itself.
 */
export function selectDialogInitialFocus(panel: HTMLElement, coarsePointer = isCoarsePointer()): HTMLElement {
  const marked = panel.querySelector<HTMLElement>('[data-dialog-initial-focus]');
  if (marked && !marked.hasAttribute('disabled') && !marked.closest('[hidden], [inert]')) return marked;
  const focusables = focusableElements(panel);
  if (!coarsePointer) {
    const body = panel.querySelector<HTMLElement>('.zc-dialog-body') ?? panel;
    const firstInput = [...body.querySelectorAll<HTMLElement>(FORM_INPUT_SELECTOR)].find((el) => (
      !el.hidden && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[hidden], [inert]') && el.tabIndex >= 0
    ));
    if (firstInput) return firstInput;
    const firstNonClose = focusables.find((el) => !el.getAttribute('aria-label')?.startsWith('关闭'));
    if (firstNonClose) return firstNonClose;
  } else {
    const firstNonInput = focusables.find((el) => !el.matches('input, textarea'));
    if (firstNonInput) return firstNonInput;
  }
  return focusables[0] ?? panel;
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
  header?: ReactNode;
  footer?: ReactNode;
  labelledBy: string;
  describedBy?: string;
  onDismiss?: () => void;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  dismissDisabled?: boolean;
  onSaveShortcut?: () => void;
  onSaveContinueShortcut?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  backdropClassName?: string;
  panelClassName?: string;
  backdropStyle?: CSSProperties;
  panelStyle?: CSSProperties;
}

/** The surface clips its corners; only the middle pane scrolls. */
export function DialogContent({ header, footer, children }: Pick<DialogShellProps, 'header' | 'footer' | 'children'>) {
  if (header == null && footer == null) return <>{children}</>;
  return <>
    {header != null && <div className="zc-dialog-head">{header}</div>}
    <div className="zc-dialog-body">{children}</div>
    {footer != null && <div className="zc-dialog-foot">{footer}</div>}
  </>;
}

function cssLimit(value: CSSProperties['maxHeight'] | CSSProperties['maxWidth']): string {
  return typeof value === 'number' ? `${value}px` : value && !['none', 'initial', 'unset'].includes(value) ? value : '100%';
}

/**
 * Shared modal foundation. Dialogs render into the app's themed portal host so
 * they are not clipped by page overflow, while React's tree still preserves
 * nested dialog ownership. Focus is trapped per physical panel, which keeps a
 * child portal from also triggering its parent's keyboard handler.
 */
export function DialogShell({
  children,
  header,
  footer,
  labelledBy,
  describedBy,
  onDismiss,
  closeOnEscape = true,
  closeOnBackdrop = true,
  dismissDisabled = false,
  onSaveShortcut,
  onSaveContinueShortcut,
  initialFocusRef,
  backdropClassName = 'zc-backdrop',
  panelClassName,
  backdropStyle,
  panelStyle,
}: DialogShellProps) {
  const framed = header != null || footer != null;
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
  useMobileDialogHistory(onDismiss, dismissDisabled, !!portalTarget);

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
      const preferred = initialFocusRef?.current ?? selectDialogInitialFocus(panel);
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
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !dismissDisabled) {
      if (event.shiftKey && onSaveContinueShortcut) {
        event.preventDefault(); event.stopPropagation(); onSaveContinueShortcut(); return;
      }
      if (!event.shiftKey && onSaveShortcut) {
        event.preventDefault(); event.stopPropagation(); onSaveShortcut(); return;
      }
    }
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
          className={['zc-dialog-panel', framed && 'has-frame', panelClassName].filter(Boolean).join(' ')}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          tabIndex={-1}
          style={{ ...panelStyle,
            maxWidth: `min(${cssLimit(panelStyle?.maxWidth)}, 100%)`,
            maxHeight: `min(${cssLimit(panelStyle?.maxHeight)}, calc(100dvh - var(--dialog-outer-top, 24px) - var(--dialog-outer-bottom, 24px)))`,
            ...(framed ? { padding: 0, overflow: 'hidden' } : {}),
          }}
          onKeyDown={onKeyDown}
        >
          <DialogContent header={header} footer={footer}>{children}</DialogContent>
        </div>
      </div>
    </DialogLayerContext.Provider>,
    portalTarget,
  );
}
