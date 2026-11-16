import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { useCompactView } from './useCompactView.js';
import { hasMobileDialog } from './mobile-dialog-history.js';

export interface TaskLink {
  label: string;
  note?: ReactNode;
  value?: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}

export function TaskList({ title, items, label }: { title?: string; label?: string; items: TaskLink[] }) {
  const heading = useId();
  return <section className="zc-task-list" aria-labelledby={title ? heading : undefined} aria-label={title ? undefined : label}>
    {title && <h2 id={heading}>{title}</h2>}
    <div>{items.map(({ label: text, note, value, icon: Icon, onClick, disabled }, index) => <button type="button" key={`${text}-${index}`} aria-label={text} aria-describedby={note || value != null ? `${heading}-${index}-note` : undefined} onClick={onClick} disabled={disabled}>
      {Icon && <Icon className="zc-task-list-icon" size={20} aria-hidden="true" />}
      <span className="zc-task-list-copy"><strong>{text}</strong>{note && <span id={`${heading}-${index}-note`}>{note}{value != null && <span className="zc-sr-only"> · {value}</span>}</span>}</span>
      {value != null && <span id={!note ? `${heading}-${index}-note` : undefined} className="zc-task-list-value">{value}</span>}
      <ChevronRight size={17} aria-hidden="true" />
    </button>)}</div>
  </section>;
}

export function MobilePageHeader({ title, onBack, backLabel = '返回', action }: { title: string; onBack: () => void; backLabel?: string; action?: ReactNode }) {
  return <div className="zc-mobile-page-head">
    <button type="button" className="zc-mobile-back" aria-label={backLabel} onClick={onBack}><ArrowLeft size={20} aria-hidden="true" /><span>{backLabel}</span></button>
    <h2>{title}</h2>{action && <div className="zc-mobile-page-action">{action}</div>}
  </div>;
}

export function MobileDisclosure({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  const compact = useCompactView();
  if (!compact) return <>{children}</>;
  return <details className="zc-mobile-disclosure" open={initiallyOpen}><summary>{title}</summary><div>{children}</div></details>;
}

interface MobileViewState { zcScreen?: string; zcMobileView?: { screen: string; key: string }; }
export function mobileViewKey(state: MobileViewState | null, screen: string, fallback = 'index') {
  return state?.zcMobileView?.screen === screen && typeof state.zcMobileView.key === 'string' ? state.zcMobileView.key : fallback;
}

/** Subpages keep a real browser history entry, shared by the web and Android webview. */
export function useMobileSection(screen: string, fallback = 'index') {
  const compact = useCompactView();
  const [section, setSection] = useState(() => typeof window === 'undefined' ? fallback : mobileViewKey(history.state, screen, fallback));
  const sectionRef = useRef(section);
  const compactRef = useRef(compact);
  sectionRef.current = section; compactRef.current = compact;
  useEffect(() => {
    const restore = () => { if (!hasMobileDialog() && (!history.state?.zcScreen || history.state.zcScreen === screen)) setSection(mobileViewKey(history.state, screen, fallback)); };
    const reset = (event: Event) => {
      if ((event as CustomEvent).detail?.screen === screen) {
        history.replaceState({ ...history.state, zcMobileView: undefined }, '');
        setSection(fallback);
      }
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('zichan:reset-page', reset);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('zichan:reset-page', reset); };
  }, [screen, fallback]);
  const select = useCallback((next: string) => {
    if (next === sectionRef.current) return;
    if (compactRef.current) {
      // Desktop navigation may not have created a mobile history entry before
      // the viewport changed. Anchor this visible parent before adding its child.
      if (!history.state?.zcDialog && history.state?.zcScreen !== screen) {
        history.replaceState({ ...history.state, zcScreen: screen, zcMobileView: { screen, key: sectionRef.current } }, '');
      }
      const nextState = { ...history.state, zcDialog: undefined, zcScreen: screen, zcMobileView: { screen, key: next } };
      if (history.state?.zcDialog) history.replaceState(nextState, '');
      else history.pushState(nextState, '');
    }
    sectionRef.current = next;
    setSection(next);
    if (compactRef.current) window.scrollTo({ top: 0 });
  }, [screen]);
  const back = useCallback(() => {
    if (compactRef.current && history.state?.zcMobileView?.screen === screen && sectionRef.current !== fallback) history.back();
    else setSection(fallback);
  }, [screen, fallback]);
  return [section, select, back] as const;
}
