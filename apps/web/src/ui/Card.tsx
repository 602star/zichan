import { useId, type ComponentPropsWithoutRef, type ElementType, type HTMLAttributes, type ReactNode } from 'react';

type Tone = 'default' | 'positive' | 'negative' | 'warning' | 'danger' | 'accent';
type CardOwnProps<T extends ElementType> = {
  as?: T;
  title?: ReactNode;
  titleId?: string;
  heading?: 'h2' | 'h3' | 'h4';
  note?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  variant?: 'tight' | 'flush';
  children?: ReactNode;
  className?: string;
};
type CardProps<T extends ElementType> = CardOwnProps<T> & Omit<ComponentPropsWithoutRef<T>, keyof CardOwnProps<T>>;

/** One independent information group. `as` preserves article/details/button semantics. */
export function Card<T extends ElementType = 'section'>({
  as, title, titleId, heading, note, action, footer, variant, children, className = '', ...props
}: CardProps<T>) {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;
  const Tag: ElementType = as ?? 'section';
  return (
    <Tag
      aria-labelledby={title != null ? headingId : undefined}
      {...props}
      className={['zc-card', variant && `is-${variant}`, className].filter(Boolean).join(' ')}
    >
      {(title != null || note != null || action != null) && (
        <CardHead title={title} id={headingId} heading={heading} note={note} action={action} />
      )}
      {children}
      {footer != null && <div className="zc-card-foot">{footer}</div>}
    </Tag>
  );
}

/** Shared by Card and the compatibility CardHeader export. */
export function CardHead({ title, note, action, id, heading = 'h2' }: {
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  id?: string;
  heading?: 'h2' | 'h3' | 'h4';
}) {
  const Heading = heading;
  return (
    <div className="zc-card-head">
      {title != null && <Heading className="zc-card-head-title" id={id}>{title}</Heading>}
      {note != null && <span className="zc-card-head-note">{note}</span>}
      {action != null && <div className="zc-card-head-action">{action}</div>}
    </div>
  );
}

/** Internal groups have a single rule between siblings, never another sheet. */
export function CardGroup({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`zc-card-group ${className}`.trim()}>{children}</div>;
}

export function CardMetric({ label, value, note, tone = 'default', className = '' }: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={`zc-card-metric ${className}`.trim()}>
      <div className="zc-card-metric-label">{label}</div>
      <div className={`zc-card-metric-value is-${tone}`}>{value}</div>
      {note != null && <div className="zc-card-metric-note">{note}</div>}
    </div>
  );
}

export function CardFact({ label, value, tone = 'default' }: { label: ReactNode; value: ReactNode; tone?: Tone }) {
  return (
    <div className="zc-card-fact">
      <span className="zc-card-fact-label">{label}</span>
      <span className={`zc-card-fact-value is-${tone}`}>{value}</span>
    </div>
  );
}

/** Notices can appear inside a sheet without nesting another card. */
export function CardAlert({ tone = 'warning', className = '', role = 'status', ...props }: HTMLAttributes<HTMLDivElement> & {
  tone?: 'warning' | 'danger';
}) {
  return <div {...props} role={role} className={`zc-alert is-${tone} ${className}`.trim()} />;
}

export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="zc-card-empty">{children}</p>;
}
