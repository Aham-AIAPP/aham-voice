import { cn } from "@/utils/cn";

// .diag — diagnostic row: code · message · 1-2 actions.
// Aham forbids red banners and toasts — diagnostics live inline.
export function Diag({
  code,
  tone = "danger",
  children,
  actions,
  className,
}: {
  code?: string;
  tone?: "danger" | "warning" | "info";
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("diag", className)}
      data-tone={tone === "danger" ? undefined : tone}
    >
      {code && <span className="diag__code">{code}</span>}
      <span className="diag__msg">{children}</span>
      {actions && <span className="diag__actions">{actions}</span>}
    </div>
  );
}
