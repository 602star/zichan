import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DialogContent, DialogShell, selectDialogInitialFocus, type DialogShellProps } from './DialogShell.js';
import { useCompactView } from './useCompactView.js';

const WorkspaceContext = createContext(false);

export interface WorkspaceDialogProps extends DialogShellProps {
  workspace?: 'page' | 'composer' | false;
  navigationBlocked?: boolean;
  onSaveShortcut?: () => void;
  onSaveContinueShortcut?: () => void;
}

/** One business form, presented in the desktop workspace or the phone's dialog. */
export function WorkspaceDialog({ workspace = 'page', navigationBlocked, onSaveShortcut, onSaveContinueShortcut, ...props }: WorkspaceDialogProps) {
  const compact = useCompactView();
  const nested = useContext(WorkspaceContext);
  const host = typeof document === 'undefined' ? null : document.getElementById('zc-workspace-editor');
  if (compact || nested || !workspace || !host) return <DialogShell {...props} onSaveShortcut={onSaveShortcut} onSaveContinueShortcut={onSaveContinueShortcut} />;
  return <DesktopEditor {...props} host={host} workspace={workspace} navigationBlocked={navigationBlocked} onSaveShortcut={onSaveShortcut} onSaveContinueShortcut={onSaveContinueShortcut} />;
}

function DesktopEditor({ host, workspace, navigationBlocked, onSaveShortcut, onSaveContinueShortcut, initialFocusRef, children, header, footer, labelledBy, describedBy, onDismiss, dismissDisabled, panelClassName, panelStyle }: WorkspaceDialogProps & { host: HTMLElement; workspace: 'page' | 'composer' }) {
  const framed = header != null || footer != null;
  const panel = useRef<HTMLElement>(null);
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ navigationBlocked, onDismiss, dismissDisabled });
  latest.current = { navigationBlocked, onDismiss, dismissDisabled };
  useLayoutEffect(() => {
    if (!framed) return;
    const appHeader = document.querySelector('.zc-app-header');
    const update = () => panel.current?.style.setProperty('--workspace-header-height', `${appHeader?.getBoundingClientRect().height ?? 0}px`);
    update();
    const observer = new ResizeObserver(update);
    if (appHeader) observer.observe(appHeader);
    return () => observer.disconnect();
  }, [framed]);
  useLayoutEffect(() => {
    const container = host.parentElement!;
    container.dataset.workspaceMode = workspace;
    const beforeNavigate = (event: Event) => {
      const current = latest.current;
      if (current.navigationBlocked || current.dismissDisabled) {
        event.preventDefault();
        if (!current.dismissDisabled) current.onDismiss?.();
      } else current.onDismiss?.();
    };
    window.addEventListener('zichan:before-navigate', beforeNavigate);
    if (panel.current) {
      const target = initialFocusRef?.current ?? selectDialogInitialFocus(panel.current, false);
      target?.focus({ preventScroll: true });
    }
    if (workspace === 'page') host.scrollIntoView({ block: 'start' });
    return () => {
      window.removeEventListener('zichan:before-navigate', beforeNavigate);
      delete container.dataset.workspaceMode;
      if (returnFocus?.isConnected && !document.querySelector('[aria-modal="true"]')) returnFocus.focus({ preventScroll: true });
    };
  }, [host, workspace, returnFocus, initialFocusRef]);
  return createPortal(<WorkspaceContext.Provider value={true}>
    <section ref={panel} role="dialog" aria-modal="false" aria-labelledby={labelledBy} aria-describedby={describedBy}
      className={`zc-workspace-editor is-${workspace}${framed ? ' has-frame' : ''}${panelClassName ? ` ${panelClassName}` : ''}`} style={{ ...panelStyle, width: '100%', maxWidth: undefined, maxHeight: framed ? 'calc(100dvh - var(--workspace-header-height, 96px) - var(--sp-5) * 2)' : undefined, height: 'auto', overflow: framed ? 'hidden' : 'visible', padding: framed ? 0 : 'var(--sp-5)', borderRadius: 'var(--r-md)', boxShadow: 'none' }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
        if (event.key === 'Escape' && !dismissDisabled) { event.preventDefault(); onDismiss?.(); }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !dismissDisabled) {
          if (event.shiftKey && onSaveContinueShortcut) { event.preventDefault(); onSaveContinueShortcut(); }
          else if (!event.shiftKey && onSaveShortcut) { event.preventDefault(); onSaveShortcut(); }
        }
      }}>
      <DialogContent header={header} footer={footer}>{children}</DialogContent>
    </section>
  </WorkspaceContext.Provider>, host);
}
