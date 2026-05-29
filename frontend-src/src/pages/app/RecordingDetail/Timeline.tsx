import { useMemo } from "react";
import { cn } from "@/utils/cn";
import { formatRelative } from "@/utils/format";
import type { Recording, RecordingTask, Summary, CrmSync, TranscriptSegment, EmotionAnalysis } from "@/api/types";
import { EMOTION_KEY } from "./Preview";

type Tone = "moss" | "accent" | "rust" | "amber" | "muted";

interface ArtifactRef {
  type: string;      // "MD"
  filename: string;  // e.g. "summary-v1.md", "transcript.md"
  meta: string;      // e.g. "v1 · deepseek-v4-pro" / "168 段 · 2 位说话人"
}

interface TimelineEvent {
  id: string;
  at: string;
  title: string;
  detail?: string;
  tone: Tone;
  /** When set, renders as a clickable .msg-attachment doc card instead of
   *  plain text. The card lets the user "open" the artifact in the rail. */
  artifact?: ArtifactRef;
  /** Inline progress bar for tasks that are currently running. */
  task?: {
    progress: number;
    elapsedLabel: string;
    isStale: boolean;
    state: "running" | "done" | "failed";
  };
  onClick?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
}

interface Props {
  recording: Recording;
  tasks: RecordingTask[];
  summaries: Summary[];
  segments: TranscriptSegment[];
  crmSync: CrmSync;
  emotion: EmotionAnalysis | null;
  onPreviewSummary: (summaryId: string) => void;
  onPreviewTranscript: () => void;
  onPreviewEmotion: () => void;
  onGenerateEmotion: () => void;
  emotionPending: boolean;
  onOpenCrm: () => void;
}

function taskTone(status: RecordingTask["status"]): Tone {
  switch (status) {
    case "done":
      return "moss";
    case "running":
      return "accent";
    case "queued":
      return "amber";
    case "failed":
      return "rust";
    default:
      return "muted";
  }
}

function crmTone(status: CrmSync["status"]): Tone {
  switch (status) {
    case "synced":
      return "moss";
    case "syncing":
      return "accent";
    case "failed":
      return "rust";
    case "not_configured":
      return "amber";
    default:
      return "muted";
  }
}

function isTranscribeStep(step: string): boolean {
  return /VAD|转写/.test(step);
}

function buildEvents(props: Props): TimelineEvent[] {
  const { recording: rec, tasks, summaries, segments, crmSync, emotion, onPreviewSummary, onPreviewTranscript, onPreviewEmotion, onGenerateEmotion, emotionPending, onOpenCrm } = props;
  const events: TimelineEvent[] = [];

  events.push({
    id: `created:${rec.id}`,
    at: rec.created_at,
    title: "已新增录音",
    detail: `原始文件 ${rec.filename} · 已保存到本机`,
    tone: "moss",
  });

  events.push({
    id: `analysis:${rec.id}`,
    at: rec.created_at,
    title: "音频分析",
    detail: `读取音频时长 ${rec.duration_label}，准备本地模型处理`,
    tone: "moss",
  });

  for (const t of tasks) {
    events.push({
      id: `task:${t.id}`,
      at: t.started_at || t.created_at,
      title: t.step,
      detail:
        t.status === "failed"
          ? t.error || "失败"
          : t.status === "done"
            ? `耗时 ${t.elapsed_label}`
            : `进度 ${t.progress}% · 已耗时 ${t.elapsed_label}${t.eta_label ? ` · 预计 ${t.eta_label}` : ""}`,
      tone: taskTone(t.status),
      task:
        t.status === "running" || t.status === "queued"
          ? {
              progress: t.progress,
              elapsedLabel: t.elapsed_label,
              isStale: t.is_stale,
              state: "running",
            }
          : t.status === "failed"
            ? { progress: t.progress, elapsedLabel: t.elapsed_label, isStale: false, state: "failed" }
            : { progress: 100, elapsedLabel: t.elapsed_label, isStale: false, state: "done" },
    });
  }

  // Synthetic "transcript ready" doc card right after the transcribe task
  // finishes — so the user can preview the逐字稿 from the timeline. Only one
  // such card per recording even if transcribe was retried multiple times.
  const lastDoneTranscribe = [...tasks]
    .filter((t) => isTranscribeStep(t.step) && t.status === "done")
    .sort((a, b) => (a.finished_at || a.updated_at).localeCompare(b.finished_at || b.updated_at))
    .at(-1);
  if (lastDoneTranscribe && segments.length > 0) {
    const uniqueSpeakers = new Set(segments.map((s) => s.speaker)).size;
    events.push({
      id: `transcript:ready`,
      at: lastDoneTranscribe.finished_at || lastDoneTranscribe.updated_at,
      title: "逐字稿就绪",
      tone: "moss",
      artifact: {
        type: "MD",
        filename: "逐字稿",
        meta: `${segments.length} 段发言 · ${uniqueSpeakers} 位说话人`,
      },
      onClick: onPreviewTranscript,
    });
  }

  for (const s of summaries) {
    const headline = s.instruction ? `按要求修改纪要 v${s.version}` : `生成纪要 v${s.version}`;
    events.push({
      id: `summary:${s.id}`,
      at: s.created_at,
      title: headline,
      detail: s.instruction
        ? `「${s.instruction.length > 50 ? s.instruction.slice(0, 50) + "…" : s.instruction}」`
        : undefined,
      tone: "moss",
      artifact: {
        type: "MD",
        filename: `会议纪要 v${s.version}`,
        meta: `${s.model}${s.is_current ? " · 当前版本" : ""}`,
      },
      onClick: () => onPreviewSummary(s.id),
    });
  }

  // 对话情绪分析：已生成 → 文档卡；未生成且转写完成 → 按需生成入口。
  if (emotion) {
    events.push({
      id: `emotion:${emotion.id}`,
      at: emotion.created_at,
      title: "对话情绪分析",
      tone: "moss",
      artifact: {
        type: "MD",
        filename: "对话情绪分析",
        meta: emotion.model,
      },
      onClick: onPreviewEmotion,
    });
  } else if (rec.asr_status === "done") {
    events.push({
      id: "emotion:gen",
      at: rec.updated_at,
      title: "对话情绪分析",
      detail: emotionPending
        ? "正在分析说话情绪、客户意向与异议…"
        : "识别说话情绪、客户意向与异议（独立于纪要，可单独下载）",
      tone: emotionPending ? "accent" : "muted",
      onClick: onGenerateEmotion,
      actionLabel: emotionPending ? "分析中…" : "生成对话情绪分析",
      actionDisabled: emotionPending,
    });
  }

  if (crmSync.synced_at || crmSync.status === "failed") {
    const targetText = crmSync.relation_target_name
      ? `关联 ${crmSync.relation_target_name}`
      : crmSync.error
        ? `错误：${crmSync.error.slice(0, 80)}`
        : crmSync.status === "not_configured"
          ? "NewCRM 同步未配置"
          : "未关联";
    events.push({
      id: "crm",
      at: crmSync.synced_at || rec.updated_at,
      title: "同步到 NewCRM",
      detail: targetText,
      tone: crmTone(crmSync.status),
      onClick: onOpenCrm,
    });
  }

  // Stable timestamp sort with a type-priority tiebreaker so events sharing
  // the same second still render in the canonical pipeline order.
  const TYPE_ORDER: Record<string, number> = {
    created: 0,
    analysis: 1,
    task: 2,
    transcript: 3,
    summary: 4,
    emotion: 5,
    crm: 6,
  };
  events.sort((a, b) => {
    const t = a.at.localeCompare(b.at);
    if (t !== 0) return t;
    const ta = TYPE_ORDER[a.id.split(":")[0]] ?? 99;
    const tb = TYPE_ORDER[b.id.split(":")[0]] ?? 99;
    return ta - tb;
  });
  return events;
}

function overallProgress(rec: Recording, tasks: RecordingTask[]): number {
  const asrDone = rec.asr_status === "done";
  const sumDone = rec.summary_status === "done";
  if (asrDone && sumDone) return 100;
  const runningProgress = (re: RegExp): number => {
    const t = [...tasks].reverse().find((x) => re.test(x.step) && (x.status === "running" || x.status === "queued"));
    return t ? Math.max(0, Math.min(100, t.progress)) : 0;
  };
  // 转写占整体 70%、纪要占 30%；瞬时的「新增录音/音频分析」不计入，开局接近 0。
  let asrPct = 0;
  if (asrDone) asrPct = 100;
  else if (rec.asr_status === "running") asrPct = runningProgress(/VAD|转写/) || 5;
  else if (rec.asr_status === "queued") asrPct = 2;
  else if (rec.asr_status === "failed") asrPct = runningProgress(/VAD|转写/);
  let sumPct = 0;
  if (sumDone) sumPct = 100;
  else if (rec.summary_status === "running") sumPct = runningProgress(/纪要/) || 5;
  return Math.max(0, Math.min(99, Math.round(asrPct * 0.7 + sumPct * 0.3)));
}

interface TimelineProps extends Props {
  /** Key of the artifact currently visible in the rail; we highlight the
   *  matching doc card on the timeline. */
  activePreviewKey: string | null;
}

export function Timeline(props: TimelineProps) {
  const events = useMemo(() => buildEvents(props), [props]);
  const donePct = overallProgress(props.recording, props.tasks);
  const stagesDone =
    (props.recording.asr_status === "done" ? 1 : 0) + (props.recording.summary_status === "done" ? 1 : 0);
  const currentEvent = events.find((e) => e.tone === "accent" || e.tone === "amber" || e.tone === "rust");
  const currentLabel = donePct >= 100 ? "已完成" : currentEvent ? currentEvent.title : "处理中";

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", margin: 0 }}>
          录音处理时间线
        </h3>
        <span className="meta" style={{ fontSize: "var(--text-xs)", color: "var(--fg-subtle)" }}>
          {stagesDone}/2 阶段 · {donePct}%
        </span>
      </header>

      <div className={cn("task", donePct >= 100 && "is-done")} style={{ border: 0, padding: 0, background: "transparent" }}>
        <div className="task__head">
          <span className="task__name">整体进度</span>
          <span className="task__step">{donePct}%</span>
        </div>
        <div className="task__bar">
          <div className="task__fill" style={{ width: `${donePct}%` }} />
        </div>
      </div>

      <p className="meta" style={{ fontSize: "var(--text-xs)", color: "var(--fg-subtle)", margin: 0 }}>
        当前：{currentLabel}
      </p>

      <ol className="nv-timeline" style={{ marginTop: "var(--space-2)" }}>
        {events.map((event) => {
          const isActive = !!event.artifact && !!props.activePreviewKey && (
            (event.id.startsWith("summary:") && event.id === `summary:${props.activePreviewKey.split(":")[1]}`) ||
            (event.id === "transcript:ready" && props.activePreviewKey === "transcript") ||
            (event.id.startsWith("emotion:") && props.activePreviewKey === EMOTION_KEY)
          );
          return (
            <li
              key={event.id}
              className={cn("nv-timeline__item", `nv-timeline__item--${event.tone}`)}
            >
              <div className="nv-timeline__rail">
                <span className="nv-timeline__dot" aria-hidden />
              </div>
              <div className="nv-timeline__content">
                <p className="nv-timeline__title">{event.title}</p>
                <p className="nv-timeline__when">{formatRelative(event.at)}</p>
                {event.detail && <p className="nv-timeline__detail">{event.detail}</p>}
                {event.task && event.task.state === "running" && (
                  <div
                    className={cn("task", event.task.isStale && "is-indeterminate")}
                    style={{ marginTop: "var(--space-2)", border: 0, padding: 0, background: "transparent" }}
                  >
                    <div className="task__bar">
                      <div className="task__fill" style={{ width: `${event.task.progress}%` }} />
                    </div>
                  </div>
                )}
                {event.artifact && (
                  <button
                    type="button"
                    className={cn("msg-attachment", isActive && "is-active")}
                    onClick={event.onClick}
                    style={{
                      appearance: "none",
                      width: "100%",
                      textAlign: "left",
                      cursor: "pointer",
                      marginTop: "var(--space-2)",
                      font: "inherit",
                      color: "inherit",
                      background: isActive ? "var(--accent-soft)" : "var(--bg-canvas)",
                      borderColor: isActive ? "var(--accent-default)" : undefined,
                    }}
                  >
                    <span className="msg-attachment__type">{event.artifact.type}</span>
                    <span className="msg-attachment__body">
                      <span className="msg-attachment__name">{event.artifact.filename}</span>
                      <span className="msg-attachment__meta">
                        <span>{event.artifact.meta}</span>
                      </span>
                    </span>
                    <span className="msg-attachment__actions">
                      <span>{isActive ? "正在预览" : "预览 →"}</span>
                    </span>
                  </button>
                )}
                {!event.artifact && event.onClick && (
                  <button
                    type="button"
                    disabled={event.actionDisabled}
                    onClick={event.actionDisabled ? undefined : event.onClick}
                    style={{
                      appearance: "none",
                      background: "transparent",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--radius-sm)",
                      padding: "var(--space-1) var(--space-3)",
                      marginTop: "var(--space-2)",
                      font: "inherit",
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-default)",
                      cursor: event.actionDisabled ? "default" : "pointer",
                      opacity: event.actionDisabled ? 0.6 : 1,
                    }}
                  >
                    {event.actionLabel ?? "打开 →"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
