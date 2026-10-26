import type { CSSProperties } from "react";
import { cn } from "@/utils/cn";
import { initials } from "@/utils/format";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

// Round, neutral, one uniform treatment: --fill-muted background, --fg-muted
// initial. The Aham rule forbids per-row tone — every avatar in a list looks
// the same. The status column carries identity meaning, not the avatar.
export function Avatar({
  name,
  size = "md",
  className,
}: {
  name?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const category = Array.from(name ?? "").reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 6 + 1;
  return (
    <span
      className={cn("avatar", `avatar--${size}`, className)}
      style={{ "--avatar-color": `var(--wb-cat-${category})` } as CSSProperties}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
