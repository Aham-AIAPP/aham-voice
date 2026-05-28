import { icons } from "lucide-react";

// Aham's design system specifies Lucide icons via kebab-case names
// (e.g. `data-lucide="house"`). lucide-react actually keys its icons
// by PascalCase (Icons.House, Icons.AudioLines, etc.), so this wrapper
// converts kebab → Pascal and dispatches.
//
// Type: kept as plain string to keep the call-site ergonomics — TS doesn't
// help much when there are 1700+ icons either way; runtime-null on a bad
// name is the better tradeoff.

export type IconName = string;

const cache = new Map<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean; "aria-label"?: string }>>();

function resolveIcon(name: string) {
  if (cache.has(name)) return cache.get(name)!;
  const pascal = name
    .split("-")
    .map((s) => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : ""))
    .join("");
  const icon = (icons as Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>>)[pascal];
  if (icon) cache.set(name, icon);
  return icon;
}

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.5,
  className,
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
}: IconProps) {
  const LucideIcon = resolveIcon(name);
  if (!LucideIcon) return null;
  return (
    <LucideIcon
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    />
  );
}
