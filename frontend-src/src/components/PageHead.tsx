import { cn } from "@/utils/cn";

// .page-head — title + optional subtitle + reserved actions slot.
// Aham rule: the actions slot is ALWAYS rendered (even empty) so titles
// align across pages. The subtitle, if present, must be a fact about this
// page's data, not a description of the feature.
export function PageHead({
  title,
  subtitle,
  actions,
  readonly,
  readonlyReason,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  readonly?: boolean;
  readonlyReason?: string;
  className?: string;
}) {
  return (
    <div className={cn("page-head", className)} data-readonly={readonly ? "" : undefined}>
      <h1 className="page-head__title">{title}</h1>
      {subtitle && <p className="page-head__subtitle">{subtitle}</p>}
      <div className="page-head__actions">
        {readonly ? (
          <span className="page-head__readonly">
            <span className="status status--muted" aria-hidden="true" />
            只读 · {readonlyReason ?? "外部维护"}
          </span>
        ) : (
          actions
        )}
      </div>
    </div>
  );
}
