// A tiny CSS spinner. Aham forbids spinners as the only signal for AI work
// (use .plan-block instead), but a 16px spinner in a button or inline with
// text is fine when you really need "this small piece is working".
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: "1.5px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "newvoice-spin 700ms linear infinite",
        verticalAlign: "middle",
      }}
    />
  );
}
