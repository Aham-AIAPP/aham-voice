import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn("field", className)}
      data-state={invalid ? "error" : undefined}
      {...rest}
    />
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn("field", className)}
      data-state={invalid ? "error" : undefined}
      {...rest}
    />
  );
});

// .form-row label + control + help block. Use everywhere there's a labelled
// control — including login. The .has-error modifier paints help text red
// and tints the control border.
export function FormRow({
  label,
  hint,
  error,
  required,
  optional,
  horizontal,
  children,
  className,
  htmlFor,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  horizontal?: boolean;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div
      className={cn(
        "form-row",
        horizontal && "form-row--horizontal",
        error && "has-error",
        className,
      )}
    >
      {label && (
        <label className="form-row__label" htmlFor={htmlFor}>
          {label}
          {required && <span className="req">*</span>}
          {optional && <span className="opt">可选</span>}
        </label>
      )}
      {children}
      {(hint || error) && (
        <p className="form-row__help">{error ?? hint}</p>
      )}
    </div>
  );
}

export function FormSection({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("form-section", className)}>
      {title && <h3 className="form-section__title">{title}</h3>}
      {children}
    </section>
  );
}
