import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";

interface Props {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

// Right-side 50vw drawer. Uses the design system's .preview-drawer +
// .preview-window shell so the visual treatment (scrim + slide + edge shadow)
// matches the file preview pattern. ESC and scrim click both close.
export function Drawer({ open, title, subtitle, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Lock scroll on body while drawer is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <aside
        className="preview-drawer newvoice-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <div className="preview-window" style={{ borderRadius: 0, border: 0, boxShadow: "none", height: "100%" }}>
          <header className="preview-header">
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="preview-title">{title}</span>
              {subtitle && <span className="preview-meta">{subtitle}</span>}
            </div>
            <div className="preview-actions">
              <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
                <Icon name="x" size={16} />
              </button>
            </div>
          </header>
          <div className="preview-body" style={{ padding: "var(--space-5) var(--space-6)" }}>
            {children}
          </div>
        </div>
      </aside>
    </>,
    document.body,
  );
}
