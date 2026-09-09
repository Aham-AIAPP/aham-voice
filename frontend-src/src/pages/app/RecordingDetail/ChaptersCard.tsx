import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { regenerateChapters } from "@/api/endpoints";
import type { Chapter } from "@/api/types";
import { readApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";

/** Topic chapters over the transcript.
 *
 * The layer the transcript never had: below it is a flat list of sentences,
 * above it is the whole-meeting summary, and nothing in between told you what
 * the meeting actually moved through.
 */
export function ChaptersCard({
  recordingId,
  chapters,
  asrStatus,
  onSeek,
}: {
  recordingId: string;
  chapters: Chapter[];
  asrStatus: string;
  onSeek?: (seconds: number) => void;
}) {
  const qc = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const regenerate = useMutation({
    mutationFn: () => regenerateChapters(recordingId, instruction),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      setInstruction("");
      setNote(
        data.source.startsWith("rule")
          ? `已按本地规则分成 ${data.chapters.length} 章（停顿 + 长度）。要按议题分章，请在设置里开启 AI 增强并配置模型。`
          : `已重新分成 ${data.chapters.length} 章（第 ${data.version} 版）。`,
      );
    },
    onError: (err) => setError(readApiError(err)),
  });

  if (asrStatus !== "done") return null;

  const ruleBased = chapters.length > 0 && chapters.every((c) => c.source === "rule");

  return (
    <section className="card stack-card">
      <div className="row">
        <h3 className="text-subhead form-section__title">议题章节</h3>
        {chapters.length > 0 && (
          <Status tone={ruleBased ? "muted" : "moss"}>
            {ruleBased ? "本地规则分段" : `${chapters.length} 章`}
          </Status>
        )}
      </div>

      {chapters.length === 0 && (
        <p className="text-caption t-2" style={{ margin: 0 }}>
          还没有分章。分章把逐句稿按议题归到一起，方便跳着看，也让纪要按议题成稿。
        </p>
      )}

      {chapters.map((c, i) => (
        <div key={c.id} style={{ display: "grid", gap: 2 }}>
          <div className="row">
            <button
              type="button"
              className="link"
              onClick={() => onSeek?.(c.start_sec)}
              style={{ background: "none", border: 0, padding: 0, cursor: onSeek ? "pointer" : "default" }}
            >
              <span className="text-caption t-2">{c.start_label}</span>
            </button>
            <span className="text-body">{i + 1}. {c.title}</span>
          </div>
          {c.gist && (
            <span className="text-caption t-2" style={{ paddingInlineStart: "3.5rem" }}>{c.gist}</span>
          )}
        </div>
      ))}

      <div className="row">
        <input
          className="input"
          type="text"
          placeholder="想怎么分？例如「按客户分章」「分细一点」（留空按默认）"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button
          variant={chapters.length ? "secondary" : "primary"}
          size="sm"
          loading={regenerate.isPending}
          onClick={() => { setError(null); setNote(null); regenerate.mutate(); }}
        >
          <Icon name="list-tree" size={14} /> {chapters.length ? "重新分章" : "生成章节"}
        </Button>
      </div>

      {note && <Diag code="CHP_OK" tone="info">{note}</Diag>}
      {error && <Diag code="CHP_E">{error}</Diag>}
    </section>
  );
}
