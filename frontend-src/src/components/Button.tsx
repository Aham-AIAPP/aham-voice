import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

// Wraps the design system's .btn rules. Variants: primary / secondary /
// ghost / danger. Sizes: sm 28 · md 36 (default) · lg 44.
// Atomic units never wrap (Aham rule) — base CSS handles that.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "btn",
        variant === "primary" && "btn--primary",
        variant === "secondary" && "btn--secondary",
        variant === "ghost" && "btn--ghost",
        variant === "danger" && "btn--danger",
        size === "sm" && "btn--sm",
        size === "lg" && "btn--lg",
        loading && "btn--loading",
        className,
      )}
      disabled={disabled || loading}
      data-loading={loading ? "" : undefined}
      {...rest}
    >
      {children}
    </button>
  );
});
