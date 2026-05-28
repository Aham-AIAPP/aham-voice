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
  const dimension =
    size === "xs" ? 20 : size === "sm" ? 24 : size === "md" ? 32 : size === "lg" ? 40 : 56;
  return (
    <span
      className={cn("avatar", `avatar--${size}`, className)}
      style={{ width: dimension, height: dimension }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
