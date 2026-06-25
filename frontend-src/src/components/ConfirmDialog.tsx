import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/Button";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface Props {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  tone?: "danger" | "primary";
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Aham §8.6 弹窗:取消在左、确认在右;破坏性(danger)不上蓝、不绑默认回车。
// Esc 取消。primary 型确认绑 Return。
export function ConfirmDialog({
  open,
  title,
  body,
  tone = "danger",
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && tone === "primary") onConfirm();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, tone, onConfirm, onCancel]);

  const trapRef = useFocusTrap<HTMLDivElement>(open);

  if (!open) return null;

  return createPortal(
    <div className="ah-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={trapRef} className="ah-modal ah-modal--narrow" role="alertdialog" aria-modal="true">
        <h2 className="ah-modal__title">{title}</h2>
        {body && <div className="ah-modal__body">{body}</div>}
        <div className="ah-modal__foot">
          <Button variant="ghost" onClick={onCancel}>{cancelText}</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
