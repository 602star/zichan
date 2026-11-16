import { useEffect, type RefObject } from 'react';

/** Modal drawer/navigation focus ownership, including return to the opening control. */
export function useFocusBoundary(root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const panel = root.current;
    if (!active || !panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const elements = () => [...panel.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')]
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert],[hidden]'));
    const focusFirst = () => (elements()[0] ?? panel).focus({ preventScroll: true });
    focusFirst();
    const guard = (event: FocusEvent) => { if (event.target instanceof Node && !panel.contains(event.target)) focusFirst(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = elements();
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (!nodes.length || index < 0 || (!event.shiftKey && index === nodes.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        (event.shiftKey ? nodes.at(-1) ?? panel : nodes[0] ?? panel).focus();
      }
    };
    document.addEventListener('focusin', guard);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('focusin', guard);
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [root, active]);
}
