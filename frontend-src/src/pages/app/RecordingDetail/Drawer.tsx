import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface Props {
  open: boolean;
  /** 头部模式（默认）需要 title；raw 模式不渲染头部，children 自带窗壳（如 Preview）。 */
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** raw=true：只提供 scrim + .preview-drawer 外壳 + Esc/锁滚动/焦点陷阱，由 children 自渲染内容。 */
  raw?: boolean;
}

// 右侧 50vw 浮出抽屉。统一交互：scrim 点击关闭、Esc 关闭、锁 body 滚动、焦点陷阱。
// 普通模式自带 .preview-window + 头部；raw 模式承载自带头部的内容（如 Preview）。
export function Drawer({ open, title, subtitle, onClose, children, raw }: Props) {
  const trapRef = useFocusTrap<HTMLElement>(open);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
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
        ref={trapRef}
        className="preview-drawer newvoice-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "抽屉"}
      >
        {raw ? (
          children
        ) : (
          <div className="preview-window drw-window-flush">
            <header className="preview-header">
              <div className="u-flex-1 u-minw-0 u-flex u-col u-gap-2px">
                <span className="preview-title">{title}</span>
                {subtitle && <span className="preview-meta">{subtitle}</span>}
              </div>
              <div className="preview-actions">
                <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            </header>
            <div className="preview-body u-pad-5-6">
              {children}
            </div>
          </div>
        )}
      </aside>
    </>,
    document.body,
  );
}
