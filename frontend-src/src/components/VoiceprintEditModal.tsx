import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/Button";
import { Field, FormRow } from "@/components/Field";
import { Diag } from "@/components/Diag";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface Props {
  open: boolean;
  title?: string;
  initialName: string;
  initialNote: string;
  saving?: boolean;
  error?: string | null;
  onSave: (value: { name: string; note: string }) => void;
  onClose: () => void;
}

// 编辑声纹的姓名 + 备注。对齐 aham-voice 的 SpeakerNameModal。
export function VoiceprintEditModal({
  open,
  title = "编辑声纹",
  initialName,
  initialNote,
  saving,
  error,
  onSave,
  onClose,
}: Props) {
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState(initialNote);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setNote(initialNote);
    }
  }, [open, initialName, initialNote]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, saving, onClose]);

  const trapRef = useFocusTrap<HTMLFormElement>(open);

  if (!open) return null;

  return createPortal(
    <div
      className="ah-modal-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <form
        ref={trapRef}
        className="ah-modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), note: note.trim() });
        }}
      >
        <h2 className="ah-modal__title">{title}</h2>
        <div className="ah-modal__body">
          <FormRow label="姓名" required>
            <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="如：王晓东" autoFocus />
          </FormRow>
          <FormRow label="备注" optional hint="可选，例如所属公司、职务等。">
            <Field value={note} onChange={(e) => setNote(e.target.value)} placeholder="销售部 / 客户对接人" />
          </FormRow>
          {error && <Diag code="VP_EDIT_E">{error}</Diag>}
        </div>
        <div className="ah-modal__foot">
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>取消</Button>
          <Button variant="primary" type="submit" loading={saving} disabled={!name.trim()}>保存</Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
