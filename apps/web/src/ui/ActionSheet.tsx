import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { DialogShell } from './DialogShell.js';

export interface SheetAction {
  label: string;
  note?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/** A paper sheet for a short, deliberate choice; it shares dialog focus and scroll handling. */
export function ActionSheet({ title, description, children, actions, onClose, dismissDisabled = false }: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: SheetAction[];
  onClose: () => void;
  dismissDisabled?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <DialogShell
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      onDismiss={onClose}
      dismissDisabled={dismissDisabled}
      backdropClassName="zc-backdrop zc-action-sheet-backdrop"
      panelClassName="zc-action-sheet"
    >
      <header className="zc-action-sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="zc-action-sheet-close" aria-label={`关闭${title}`} data-dialog-initial-focus onClick={onClose} disabled={dismissDisabled}><X size={20} aria-hidden="true" /></button>
      </header>
      {description && <p className="zc-action-sheet-description" id={descriptionId}>{description}</p>}
      {children}
      {actions.length > 0 && <div className="zc-action-sheet-actions">
        {actions.map((action) => (
          <button type="button" key={action.label} onClick={action.onSelect} disabled={action.disabled}>
            {action.icon && <span className="zc-action-sheet-icon" aria-hidden="true">{action.icon}</span>}
            <span><span className="zc-action-sheet-label">{action.label}</span>{action.note && <span className="zc-action-sheet-note">{action.note}</span>}</span>
          </button>
        ))}
      </div>}
    </DialogShell>
  );
}
