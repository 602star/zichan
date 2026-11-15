import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DialogShell, type DialogShellProps } from './DialogShell.js';
import { useCompactView } from './useCompactView.js';

const WorkspaceContext = createContext(false);

export interface WorkspaceDialogProps extends DialogShellProps {
  workspace?: 'page' | 'composer' | false;
  navigationBlocked?: boolean;
  onSaveShortcut?: () => void;
}

/** One business form, presented in the desktop workspace or the phone's dialog. */
export function WorkspaceDialog({ workspace = 'page', navigationBlocked, onSaveShortcut, ...props }: WorkspaceDialogProps) {
  const compact = useCompactView();
  const nested = useContext(WorkspaceContext);
  const host = typeof document === 'undefined' ? null : document.getElementById('zc-workspace-editor');
  if (compact || nested || !workspace || !host) return <DialogShell {...props} />;
  return <DesktopEditor {...props} host={host} workspace={workspace} navigationBlocked={navigationBlocked} onSaveShortcut={onSaveShortcut} />;
}

function DesktopEditor({ host, workspace, navigationBlocked, onSaveShortcut, children, labelledBy, describedBy, onDismiss, dismissDisabled, panelClassName, panelStyle }: WorkspaceDialogProps & { host: HTMLElement; workspace: 'page' | 'composer' }) {
  const panel = useRef<HTMLElement>(null);
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ navigationBlocked, onDismiss, dismissDisabled });
  latest.current = { navigationBlocked, onDismiss, dismissDisabled };
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
    const target = panel.current?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, [data-dialog-initial-focus]');
    target?.focus({ preventScroll: true });
    if (workspace === 'page') host.scrollIntoView({ block: 'start' });
    return () => {
      window.removeEventListener('zichan:before-navigate', beforeNavigate);
      delete container.dataset.workspaceMode;
      if (returnFocus?.isConnected && !document.querySelector('[aria-modal="true"]')) returnFocus.focus({ preventScroll: true });
    };
  }, [host, workspace, returnFocus]);
  return createPortal(<WorkspaceContext.Provider value={true}>
    <section ref={panel} role="dialog" aria-modal="false" aria-labelledby={labelledBy} aria-describedby={describedBy}
      className={`zc-workspace-editor is-${workspace}${panelClassName ? ` ${panelClassName}` : ''}`} style={{ ...panelStyle, width: '100%', maxWidth: undefined, maxHeight: undefined, height: 'auto', overflow: 'visible', padding: 'var(--sp-5)', borderRadius: 'var(--r-md)', boxShadow: 'none' }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
        if (event.key === 'Escape' && !dismissDisabled) { event.preventDefault(); onDismiss?.(); }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !dismissDisabled && onSaveShortcut) { event.preventDefault(); onSaveShortcut(); }
      }}>
      {children}
    </section>
  </WorkspaceContext.Provider>, host);
}
