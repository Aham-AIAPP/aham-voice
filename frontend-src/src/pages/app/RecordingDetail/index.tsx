import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchRecording, processRecording, generateEmotion } from "@/api/endpoints";
import { readApiError } from "@/api/client";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";
import { PageLoading } from "@/components/PageLoading";
import { Status } from "@/components/Status";
import { formatRelative } from "@/utils/format";
import { overallLabel } from "@/utils/status";
import { RecordingCard } from "./RecordingCard";
import { SpeakersCard } from "./SpeakersCard";
import { ChaptersCard } from "./ChaptersCard";
import { Timeline } from "./Timeline";
import { Preview, TRANSCRIPT_KEY, EMOTION_KEY, summaryArtifactKey, type ArtifactKey } from "./Preview";
import { ReviseComposer } from "./ReviseComposer";

function overallTone(asr: string, summary: string): React.ComponentProps<typeof Status>["tone"] {
  if (asr === "failed" || summary === "failed") return "rust";
  if (asr === "running" || summary === "running") return "accent";
  if (asr === "queued") return "amber";
  if (asr === "done" && summary === "done") return "moss";
  if (asr === "done") return "accent";
  return "muted";
}

export function RecordingDetail() {
  const { id } = useParams<{ id: string }>();
  const recordingId = id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();

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

  // Rail-preview selection. null = floating preview closed (default).
  const [previewKey, setPreviewKey] = useState<ArtifactKey | null>(null);

  const summaries = detail.data?.summaries ?? [];
  const currentSummary = useMemo(
    () => summaries.find((s) => s.is_current) ?? summaries[0] ?? null,
    [summaries],
  );

  // When the user revises and a new current summary appears, follow them to
  // the new version IF they're already previewing a summary. Never auto-open
  // the preview.
  useEffect(() => {
    if (!currentSummary || !previewKey || !previewKey.startsWith("summary:")) return;
    const sid = previewKey.slice("summary:".length);
    const old = summaries.find((s) => s.id === sid);
    if (old && !old.is_current && currentSummary.id !== sid) {
      setPreviewKey(summaryArtifactKey(currentSummary));
    }
  }, [currentSummary, previewKey, summaries]);

  if (detail.isLoading) {
    return (
      <div className="container container--content">
        <div className="page-shell">
          <div className="page-state">
            <PageLoading />
          </div>
        </div>
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="container container--content">
        <div className="page-shell">
          <div className="page-state">
            <Icon name="alert-triangle" size={48} className="page-state__icon" />
            <div className="page-state__title">打不开这条录音</div>
            <Diag code="REC_E_DETAIL">{readApiError(detail.error)}</Diag>
            <div className="page-state__actions">
              <Button variant="ghost" onClick={() => navigate("/app/recordings")}>返回列表</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="container container--content">
        <div className="page-shell">
          <div className="page-state">
            <Icon name="mic" size={48} className="page-state__icon" />
            <div className="page-state__title">没有这条录音</div>
            <p className="page-state__desc">这条录音可能已被删除。</p>
            <div className="page-state__actions">
              <Button variant="ghost" onClick={() => navigate("/app/recordings")}>返回列表</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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

  const subtitle = (
    <>
      {rec.duration_label} · {segments.length} 段转写 · {uniqueSpeakers} 位说话人
      {rec.tag ? ` · ${rec.tag}` : ""} · {formatRelative(rec.updated_at)}
    </>
  );

  return (
    <div className="container container--content">
      <div className="page-shell">
        <PageHead
          title={rec.title}
          subtitle={subtitle}
          actions={
            <div className="row" style={{ gap: "var(--s3)" }}>
              <Status tone={tone}>{label}</Status>
              <Button
                variant="primary"
                loading={reprocess.isPending}
                disabled={reprocessDisabled}
                onClick={() => reprocess.mutate()}
              >
                <Icon name="refresh-cw" size={14} /> 重新处理
              </Button>
            </div>
          }
        />

        <div className="page-content">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
            <RecordingCard recording={rec} segments={segments} hotwordPackage={pkg} />

            <SpeakersCard recordingId={recordingId} asrStatus={rec.asr_status} />

            <ChaptersCard
              recordingId={recordingId}
              chapters={detail.data?.chapters ?? []}
              asrStatus={rec.asr_status}
            />

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

            <ReviseComposer
              recordingId={recordingId}
              disabled={composerDisabled}
              disabledReason={composerDisabledReason}
            />
          </div>
        </div>
      </div>

      {/* AI rail — floating overlay; never squeezes the centered main content.
          Slides in only when an artifact is selected from the Timeline. */}
      {previewKey !== null && (
        <>
          <div className="scrim" onClick={() => setPreviewKey(null)} />
          {/* Official .drawer; only the width differs from --rightbar-w, so it
              is the single inline override. .detail-preview stretches the
              window child to fill the rail height. */}
          <aside className="drawer detail-preview" style={{ width: "min(560px, 92vw)" }}>
            <Preview
              recordingId={recordingId}
              summaries={summaries}
              segments={segments}
              emotion={emotionAnalysis}
              selected={previewKey}
              onSelect={setPreviewKey}
              onClose={() => setPreviewKey(null)}
            />
          </aside>
        </>
      )}
    </div>
  );
}
