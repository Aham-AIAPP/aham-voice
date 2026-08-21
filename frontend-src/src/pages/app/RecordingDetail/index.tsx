import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchRecording, processRecording, generateEmotion } from "@/api/endpoints";
import { readApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Status } from "@/components/Status";
import { formatRelative } from "@/utils/format";
import { RecordingCard } from "./RecordingCard";
import { SpeakersCard } from "./SpeakersCard";
import { Timeline } from "./Timeline";
import { Preview, TRANSCRIPT_KEY, EMOTION_KEY, summaryArtifactKey, type ArtifactKey } from "./Preview";
import { ReviseComposer } from "./ReviseComposer";
import { Drawer } from "./Drawer";

function overallTone(asr: string, summary: string): React.ComponentProps<typeof Status>["tone"] {
  if (asr === "failed" || summary === "failed") return "rust";
  if (asr === "running" || summary === "running") return "accent";
  if (asr === "queued") return "amber";
  if (asr === "done" && summary === "done") return "moss";
  if (asr === "done") return "accent";
  return "muted";
}

function overallLabel(asr: string, summary: string): string {
  if (asr === "failed" || summary === "failed") return "失败";
  if (asr === "running" || summary === "running") return "处理中";
  if (asr === "queued") return "排队中";
  if (asr === "done" && summary === "done") return "已生成";
  if (asr === "done") return "等待纪要";
  return "未开始";
}

export function RecordingDetail() {
  const { id } = useParams<{ id: string }>();
  const recordingId = id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Apply the split-panel template to the body region for this route only.
  // 左侧主内容用此模板拿到稳定的视口高度（含底部 composer dock）；右侧栏始终保持
  // is-closed（grid 收成 1fr，左侧满宽），预览改为浮出抽屉（见下方 previewKey 抽屉）。
  useEffect(() => {
    const main = document.querySelector("main.app-shell__body");
    if (!main) return;
    main.classList.add("page--split-panel");
    return () => {
      main.classList.remove("page--split-panel");
    };
  }, []);

  const detail = useQuery({
    queryKey: ["recording", recordingId],
    queryFn: () => fetchRecording(recordingId),
    enabled: !!recordingId,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 6000;
      const rec = data.recording;
      const taskActive = (data.tasks ?? []).some(
        (t) => t.status === "running" || t.status === "queued",
      );
      const active =
        rec.asr_status === "running" ||
        rec.summary_status === "running" ||
        taskActive;
      return active ? 4000 : false;
    },
  });

  const reprocess = useMutation({
    mutationFn: () => processRecording(recordingId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const emotionMut = useMutation({
    mutationFn: () => generateEmotion(recordingId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // 预览选择。null = 抽屉关闭（默认）。预览以浮出抽屉形式展示（非内嵌分栏）。
  const [previewKey, setPreviewKey] = useState<ArtifactKey | null>(null);

  const summaries = detail.data?.summaries ?? [];
  const currentSummary = useMemo(
    () => summaries.find((s) => s.is_current) ?? summaries[0] ?? null,
    [summaries],
  );

  // When the user revises and a new current summary appears, follow them to
  // the new version IF they're already previewing a summary. Never auto-open
  // the rail.
  useEffect(() => {
    if (!currentSummary || !previewKey || !previewKey.startsWith("summary:")) return;
    const id = previewKey.slice("summary:".length);
    const old = summaries.find((s) => s.id === id);
    if (old && !old.is_current && currentSummary.id !== id) {
      setPreviewKey(summaryArtifactKey(currentSummary));
    }
  }, [currentSummary, previewKey, summaries]);

  if (detail.isLoading) {
    return (
      <div className="u-p-8">
        <PageLoading />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="u-p-8">
        <Diag code="REC_E_DETAIL">{readApiError(detail.error)}</Diag>
        <Button variant="ghost" onClick={() => navigate("/app/recordings")}>返回列表</Button>
      </div>
    );
  }
  if (!detail.data) return <EmptyState description="没有这条录音。" />;

  const { recording: rec, segments, tasks, hotword_package: pkg, emotion_analysis: emotionAnalysis } = detail.data;
  const emotionRunning = tasks.some(
    (t) => t.step.includes("情绪") && (t.status === "running" || t.status === "queued"),
  );
  const tone = overallTone(rec.asr_status, rec.summary_status);
  const label = overallLabel(rec.asr_status, rec.summary_status);
  const uniqueSpeakers = new Set(segments.map((s) => s.speaker)).size;
  const reprocessDisabled =
    rec.asr_status === "running" ||
    rec.summary_status === "running" ||
    rec.asr_status === "queued";

  const composerDisabled =
    rec.asr_status !== "done" || rec.summary_status === "running" || !currentSummary;
  const composerDisabledReason =
    rec.asr_status !== "done"
      ? "转写完成后才能改纪要"
      : rec.summary_status === "running"
        ? "纪要正在生成…"
        : !currentSummary
          ? "先在右侧生成一版纪要再来修改"
          : undefined;

  return (
    <>
      {/* ───────────────── LEFT (main) ───────────────── */}
      <div className="split-panel__main detail-main">
        {/* Scrollable content region (grid row 1) */}
        <div className="detail-main__scroll">
          <div className="obj-head">
            <div className="obj-head__main">
              <h1 className="obj-head__title">{rec.title}</h1>
              <div className="obj-head__meta">
                <span>{rec.duration_label}</span>
                <span>·</span>
                <span>{segments.length} 段转写</span>
                <span>·</span>
                <span>{uniqueSpeakers} 位说话人</span>
                {rec.tag && (
                  <>
                    <span>·</span>
                    <span>{rec.tag}</span>
                  </>
                )}
                <span>·</span>
                <span>{formatRelative(rec.updated_at)}</span>
              </div>
            </div>
            <div className="obj-head__status">
              <Status tone={tone}>{label}</Status>
            </div>
            <div className="obj-head__actions">
              <Button
                variant="primary"
                size="sm"
                loading={reprocess.isPending}
                disabled={reprocessDisabled}
                onClick={() => reprocess.mutate()}
              >
                <Icon name="refresh-cw" size={14} /> 重新处理
              </Button>
            </div>
          </div>

          <RecordingCard recording={rec} segments={segments} hotwordPackage={pkg} />

          <SpeakersCard recordingId={recordingId} asrStatus={rec.asr_status} />

          <Timeline
            recording={rec}
            tasks={tasks}
            summaries={summaries}
            segments={segments}
            emotion={emotionAnalysis}
            onPreviewSummary={(summaryId) => setPreviewKey(`summary:${summaryId}`)}
            onPreviewTranscript={() => setPreviewKey(TRANSCRIPT_KEY)}
            onPreviewEmotion={() => setPreviewKey(EMOTION_KEY)}
            onGenerateEmotion={() => emotionMut.mutate()}
            emotionPending={emotionMut.isPending || emotionRunning}
            activePreviewKey={previewKey}
          />
        </div>

        {/* Sticky-bottom composer dock */}
        <div className="detail-composer-dock">
          <ReviseComposer
            recordingId={recordingId}
            disabled={composerDisabled}
            disabledReason={composerDisabledReason}
          />
        </div>
      </div>

      {/* 右侧栏占位：始终 is-closed（display:none），让 split-panel 栅格收成单列、左侧满宽。
          预览本身改为下面的浮出抽屉。 */}
      <aside className="split-panel__rail is-closed" aria-hidden />

      {/* ───────────────── 预览浮出抽屉（复用 Drawer：scrim/Esc/锁滚动/焦点陷阱统一）───────────────── */}
      <Drawer open={previewKey !== null} raw onClose={() => setPreviewKey(null)}>
        {previewKey !== null && (
          <Preview
            recordingId={recordingId}
            summaries={summaries}
            segments={segments}
            emotion={emotionAnalysis}
            selected={previewKey}
            onSelect={setPreviewKey}
            onClose={() => setPreviewKey(null)}
          />
        )}
      </Drawer>
    </>
  );
}
