import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reviseSummary } from "@/api/endpoints";
import { Button } from "@/components/Button";
import { Textarea } from "@/components/Field";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";

interface Props {
  recordingId: string;
  disabled: boolean;
  disabledReason?: string;
}

// The always-visible "改一下" composer at the bottom of the rail. Mirrors the
// design system's .composer shape: textarea + tools row + send button.
// Enter sends (Shift+Enter for newline) — Aham's "Enter is platform
// convention" rule means we don't surface the hint as chrome.
export function ReviseComposer({ recordingId, disabled, disabledReason }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const revise = useMutation({
    mutationFn: () => reviseSummary(recordingId, text.trim()),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  function submit(event: FormEvent | KeyboardEvent) {
    event.preventDefault();
    if (!text.trim() || disabled) return;
    setError(null);
    revise.mutate();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      submit(event);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="composer"
      style={{ borderRadius: 0, border: 0, borderTop: "1px solid var(--border-default)", padding: "var(--space-3) var(--space-4)" }}
    >
      {error && <Diag code="SUM_E_REVISE">{error}</Diag>}
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          disabled
            ? disabledReason ?? "等纪要生成完后可以在这里告诉 AI 怎么改"
            : "改一下：补一段商机分析、按客户重写第二节、删掉所有时间戳……"
        }
        rows={3}
        disabled={disabled || revise.isPending}
      />
      <div className="composer-row">
        <span className="meta" style={{ fontSize: "var(--text-2xs)", color: "var(--fg-subtle)" }}>
          每次修改会创建新版本，原版仍可翻到
        </span>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={revise.isPending}
          disabled={disabled || !text.trim()}
        >
          按要求重写
        </Button>
      </div>
    </form>
  );
}
