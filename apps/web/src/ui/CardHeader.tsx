import type { ReactNode } from 'react';

/**
 * Card section header — the shared pattern that opens every major card section.
 *
 * Before this component existed, every card re-declared the same inline flex
 * layout (display:flex + align-items:baseline + justify-content:space-between +
 * marginBottom + --fs-title + --fw-bold) in its own JSX. This component
 * centralises that pattern so each card reads as one line:
 *
 *   <CardHeader title="资产配置" note="按当前折算价值" />
 *   <CardHeader title="任务中心" action={<button>…</button>} />
 *
 * CSS vocabulary: `.zc-card-header`, `.zc-card-header-title`,
 * `.zc-card-header-note`, `.zc-card-header-action` (declared in styles.css).
 */
export function CardHeader({
  title,
  note,
  action,
  id,
}: {
  title: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  /** Optional id for aria-labelledby on the containing section or dialog. */
  id?: string;
}) {
  return (
    <div className="zc-card-header">
      <h2 className="zc-card-header-title" id={id}>{title}</h2>
      {(note || action) && (
        <>
          {note && <span className="zc-card-header-note">{note}</span>}
          {action && <span className="zc-card-header-action">{action}</span>}
        </>
      )}
    </div>
  );
}
