import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSpeakerCandidates, nameSpeakerFromRecording, renameSpeaker, segmentAudioUrl } from "@/api/endpoints";
import { readApiError } from "@/api/client";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { Status } from "@/components/Status";
import type { SpeakerCandidate } from "@/api/types";

interface Props {
  recordingId: string;
  asrStatus: string;
}

interface Playing {
  speaker: string;
  idx: number;
}

// 录音详情页左栏「从当前录音指定声纹」卡（对齐 aham-voice）。
// 每个说话人瓦片：点名字直接行内改名。能判断出来的（累计发言 ≥5s 且有可试听片段）→
// 显示试听 + 命名即建声纹（按角色解析作用域，无团队时降级为全团队共享）；判断不出来的 →
// 不显示试听、命名只回填本录音不建声纹。
export function SpeakersCard({ recordingId, asrStatus }: Props) {
  const candidates = useQuery({
    queryKey: ["speaker-candidates", recordingId],
    queryFn: () => fetchSpeakerCandidates(recordingId),
    enabled: asrStatus === "done",
  });

  return (
    <section className="card u-flex u-col u-gap-3">
      <header>
        <h3 className="u-fs-base u-fw-semibold u-m-0">
          从当前录音指定声纹
        </h3>
        <p className="meta u-fs-xs u-fg-subtle u-mt-1">
          先试听某个说话人的片段确认是谁，再点名字直接改成真实姓名。保存后本录音立即回填，并自动建立可跨录音识别的声纹。
        </p>
      </header>

      {asrStatus !== "done" ? (
        <EmptyState description="转写完成后才能识别说话人。" />
      ) : candidates.isLoading ? (
        <p className="meta u-fs-xs">正在分析说话人……</p>
      ) : !candidates.data || candidates.data.length === 0 ? (
        <EmptyState description="本次转写没有识别出任何说话人。" />
      ) : (
        <SpeakerTiles recordingId={recordingId} candidates={candidates.data} />
      )}
    </section>
  );
}

function SpeakerTiles({
  recordingId,
  candidates,
}: {
  recordingId: string;
  candidates: SpeakerCandidate[];
}) {
  // 整卡共享一个 <audio>，保证全局互斥（同一时刻只响一条）。
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);

  function play(speaker: string, idx: number, url: string) {
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    setPlaying({ speaker, idx });
    el.play().catch(() => setPlaying(null));
  }
  function stop() {
    audioRef.current?.pause();
    setPlaying(null);
  }

  return (
    <>
      <audio ref={audioRef} preload="none" onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} />
      <div className="u-grid u-gap-3 spc-tiles-grid">
        {candidates.map((c) => (
          <SpeakerTile
            key={c.speaker}
            recordingId={recordingId}
            candidate={c}
            playing={playing?.speaker === c.speaker ? playing : null}
            onPlay={(idx, url) => play(c.speaker, idx, url)}
            onStop={stop}
          />
        ))}
      </div>
    </>
  );
}

function SpeakerTile({
  recordingId,
  candidate,
  playing,
  onPlay,
  onStop,
}: {
  recordingId: string;
  candidate: SpeakerCandidate;
  playing: Playing | null;
  onPlay: (idx: number, url: string) => void;
  onStop: () => void;
}) {
  const qc = useQueryClient();
  const samples = candidate.sample_segments;
  const hasSamples = samples.length > 0;
  // 「能判断出来」= 有足够可用音频建声纹（累计发言 ≥5s 且有可试听片段）。
  // 能判断的：显示试听 + 命名即建声纹；判断不出来的：不显示试听，命名只回填本录音、不建声纹。
  const buildable = candidate.total_duration >= 5 && hasSamples;

  const [idx, setIdx] = useState(0);
  const seg = hasSamples ? samples[Math.min(idx, samples.length - 1)] : null;
  const isPlaying = playing != null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nameMut = useMutation({
    mutationFn: async (name: string) => {
      if (buildable) {
        await nameSpeakerFromRecording({ recording_id: recordingId, speaker: candidate.speaker, name });
      } else {
        await renameSpeaker(recordingId, candidate.speaker, { name });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["speaker-candidates", recordingId] });
      qc.invalidateQueries({ queryKey: ["voiceprints"] });
      setEditing(false);
    },
    onError: (err) => setError(readApiError(err)),
  });

  function startEdit() {
    setError(null);
    setDraft(candidate.speaker_name ?? "");
    setEditing(true);
  }
  function commit() {
    const name = draft.trim();
    if (!name || name === candidate.speaker_name) {
      setEditing(false);
      return;
    }
    setError(null);
    nameMut.mutate(name);
  }
  function togglePlay() {
    if (!seg) return;
    if (isPlaying) onStop();
    else onPlay(idx, segmentAudioUrl(recordingId, seg.id));
  }
  function next() {
    if (!hasSamples) return;
    const nextIdx = (idx + 1) % samples.length;
    setIdx(nextIdx);
    onPlay(nextIdx, segmentAudioUrl(recordingId, samples[nextIdx].id));
  }

  const previewText = seg ? (seg.text?.trim() ? seg.text.trim().slice(0, 28) : seg.start_label) : "无可试听片段";

  return (
    <div className="card speaker-tile">
      <div className="u-flex u-between u-items-baseline u-gap-2">
        {editing ? (
          <input
            className="field u-flex-1 u-minw-0 spc-name-input"
            autoFocus
            value={draft}
            disabled={nameMut.isPending}
            placeholder={`Speaker ${candidate.speaker}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setError(null);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            title="点击修改姓名"
            className="speaker-tile__title spc-name-btn"
            style={{
              color: candidate.speaker_name ? "var(--fg-default)" : "var(--fg-subtle)",
            }}
          >
            {candidate.speaker_name ? candidate.speaker_name : `Speaker ${candidate.speaker}`}
          </button>
        )}
        <span className="speaker-tile__meta u-shrink-0">{candidate.segment_count} 段</span>
      </div>

      {nameMut.isPending && <span className="speaker-tile__meta">保存中……</span>}
      {error && <span role="alert" className="speaker-tile__meta u-fg-danger">{error}</span>}

      <span className="speaker-tile__meta">累计 {candidate.total_duration_label}</span>

      {/* 试听控件——仅「能判断出来」（音频足以建声纹）的说话人显示；判断不出来的不试听。 */}
      {buildable ? (
        <div className="u-flex u-items-center u-gap-2 u-minw-0">
          <button
            type="button"
            className="icon-btn"
            aria-label={isPlaying ? "暂停试听" : "播放该说话人片段"}
            aria-pressed={isPlaying}
            onClick={togglePlay}
          >
            <Icon name={isPlaying ? "pause" : "play"} size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="下一段"
            disabled={samples.length < 2}
            onClick={next}
          >
            <Icon name="skip-forward" size={16} />
          </button>
          <span
            className="speaker-tile__meta u-truncate u-minw-0"
            title={seg?.text ?? undefined}
          >
            {seg ? `${seg.start_label} · ${previewText}` : ""}
          </span>
        </div>
      ) : (
        <span className="speaker-tile__meta">发言过短，无法识别声纹，仅可命名。</span>
      )}

      <Status tone={candidate.speaker_name ? "moss" : "muted"}>
        {candidate.speaker_name ? (candidate.voiceprint_id ? "已绑定声纹" : "已命名") : "未命名"}
      </Status>
    </div>
  );
}
