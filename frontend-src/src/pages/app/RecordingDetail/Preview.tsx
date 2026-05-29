import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { exportEmotionUrl, exportSummaryVersionUrl, exportTranscriptUrl } from "@/api/endpoints";
import { Icon } from "@/components/Icon";
import type { EmotionAnalysis, Summary, TranscriptSegment } from "@/api/types";

export type ArtifactKey = string;
// "summary:<id>" | "transcript"
export function summaryArtifactKey(summary: Summary): ArtifactKey {
  return `summary:${summary.id}`;
}
export const TRANSCRIPT_KEY: ArtifactKey = "transcript";
export const EMOTION_KEY: ArtifactKey = "emotion";

interface Props {
  recordingId: string;
  summaries: Summary[];
  segments: TranscriptSegment[];
  emotion: EmotionAnalysis | null;
  /** Which artifact is being previewed. Caller hides the rail entirely when
   *  null (via .is-closed), so this component always renders something. */
  selected: ArtifactKey;
  onSelect: (key: ArtifactKey) => void;
  onClose: () => void;
}

// Build the transcript markdown from segments on the client — saves a fetch
// and keeps the rail responsive while the user is reading.
function transcriptMarkdown(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return "_还没有转写。_";
  const lines: string[] = ["# 逐字稿", ""];
  for (const seg of segments) {
    const speaker = seg.speaker_name || `Speaker ${seg.speaker}`;
    lines.push(`### \`${seg.start_label}\` · ${speaker}`);
    lines.push("");
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

export function Preview({ recordingId, summaries, segments, emotion, selected, onSelect, onClose }: Props) {
  const currentSummary = useMemo(() => {
    if (!selected.startsWith("summary:")) return null;
    const id = selected.slice("summary:".length);
    return summaries.find((s) => s.id === id) ?? null;
  }, [selected, summaries]);
  const isTranscript = selected === TRANSCRIPT_KEY;
  const isEmotion = selected === EMOTION_KEY;

  const markdown = useMemo(() => {
    if (currentSummary) return currentSummary.content;
    if (isTranscript) return transcriptMarkdown(segments);
    if (isEmotion) return emotion?.content ?? "_还没有情绪分析。_";
    return "";
  }, [currentSummary, isTranscript, isEmotion, emotion, segments]);

  const displayName = currentSummary
    ? `会议纪要 v${currentSummary.version}`
    : isTranscript
      ? "逐字稿"
      : isEmotion
        ? "对话情绪分析"
        : "";

  const downloadHref = currentSummary
    ? exportSummaryVersionUrl(recordingId, currentSummary.id)
    : isTranscript
      ? exportTranscriptUrl(recordingId)
      : isEmotion
        ? exportEmotionUrl(recordingId)
        : null;

  const metaText = currentSummary
    ? `${currentSummary.model}${currentSummary.is_current ? " · 当前版本" : ""}`
    : isTranscript
      ? `${segments.length} 段发言`
      : isEmotion
        ? emotion?.model ?? ""
        : "";

  return (
    <div
      className="preview-window"
      style={{ height: "100%", borderRadius: 0, border: 0, boxShadow: "none" }}
    >
      <header className="preview-header">
        <span className="preview-type">MD</span>
        <span className="preview-title">{displayName}</span>
        <span className="preview-meta">{metaText}</span>
        <div className="preview-actions">
          {summaries.length + (segments.length > 0 ? 1 : 0) + (emotion ? 1 : 0) > 1 && (
            <select
              className="field"
              style={{ width: 168, height: 28, fontSize: "var(--text-xs)" }}
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
              aria-label="切换产物"
            >
              {summaries.map((s) => (
                <option key={s.id} value={summaryArtifactKey(s)}>
                  会议纪要 v{s.version}
                  {s.is_current ? " · 当前" : ""}
                </option>
              ))}
              {emotion && <option value={EMOTION_KEY}>对话情绪分析</option>}
              {segments.length > 0 && (
                <option value={TRANSCRIPT_KEY}>逐字稿</option>
              )}
            </select>
          )}
          {downloadHref && (
            <a href={downloadHref} download className="icon-btn" aria-label="下载">
              <Icon name="download" size={14} />
            </a>
          )}
          <button type="button" className="icon-btn" aria-label="关闭预览" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="preview-body">
        <article className="preview-doc markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
