import { cn } from "@/utils/cn";

// .status — 6px dot + label, the system's one shape for a state.
// Tones map to the canonical status vocabulary documented in the README.
export type StatusTone =
  | "neutral"
  | "accent"
  | "moss"
  | "amber"
  | "rust"
  | "slate"
  | "muted"
  | "faint";

export function Status({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "status",
        tone === "accent" && "status--accent",
        tone === "moss" && "status--moss",
        tone === "amber" && "status--amber",
        tone === "rust" && "status--rust",
        tone === "slate" && "status--slate",
        tone === "muted" && "status--muted",
        tone === "faint" && "status--faint",
        className,
      )}
    >
      {children}
    </span>
  );
}
