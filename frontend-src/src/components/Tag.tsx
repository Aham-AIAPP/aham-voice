import { cn } from "@/utils/cn";

// The system's one tag shape — used only for removable filter chips and
// the equivalent. Don't use .tag to color-code list rows; Aham's "rows
// don't wear chips" rule means categorical labels in lists are plain text.
export function Tag({
  children,
  dim,
  onClose,
  className,
}: {
  children: React.ReactNode;
  dim?: string;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <span className={cn("tag", className)}>
      {dim && <span className="dim">{dim}</span>}
      {children}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="移除"
        >
          ×
        </button>
      )}
    </span>
  );
}
