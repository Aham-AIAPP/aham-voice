import { cn } from "@/utils/cn";

// .empty-state — one sentence, max 56ch, optional ghost action.
// No illustration, no big icon, no hero text. The Aham rule is hard:
// "if you reach for a big SVG, you're filling space instead of explaining state."
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title?: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty-state", className)}>
      {title && <h3 className="empty-state__title">{title}</h3>}
      <p className="empty-state__body">{description}</p>
      {action && <div className="empty-state__actions">{action}</div>}
    </div>
  );
}
