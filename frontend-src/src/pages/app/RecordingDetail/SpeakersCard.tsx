import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSpeakerCandidates, nameSpeakerFromRecording } from "@/api/endpoints";
import { readApiError } from "@/api/client";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { Status } from "@/components/Status";
import type { SpeakerCandidate } from "@/api/types";

interface Props {
  recordingId: string;
  asrStatus: string;
}

// Which speaker+segment is currently sounding from the single shared <audio>.
// Tracked at the section level so only one clip ever plays — starting a new
// one (or hitting 下一段) just repoints the same element, which stops whatever
// was playing before.
interface Playing {
  speaker: string;
  idx: number;
}

// Left-column "从当前录音指定声纹" card. Each speaker tile lets you (a) preview
// the speaker's clipped sample segments inline (播放/下一段) to confirm who is
// talking, and (b) rename the speaker by clicking the name directly — no modal.
// Saving calls nameSpeakerFromRecording, which both renames the speaker in this
// recording and (if the speech is long enough) builds a cross-recording
// voiceprint. Short speakers are downgraded to name-only — surfaced as a hint.
export function SpeakersCard({ recordingId, asrStatus }: Props) {
  const candidates = useQuery({
    queryKey: ["speaker-candidates", recordingId],
    queryFn: () => fetchSpeakerCandidates(recordingId),
    enabled: asrStatus === "done",
  });

  return (
    <section className="card stack-card">
      <header className="field">
        <h3 className="card__head" style={{ marginBottom: 0 }}>
          <span className="ttl" style={{ fontSize: "var(--text-base)" }}>从当前录音指定声纹</span>
        </h3>
        <p className="text-caption">
          先试听某个说话人的片段确认是谁，再点名字直接改成真实姓名。保存后本录音立即回填，并自动建立可跨录音识别的声纹。
        </p>
      </header>

      {asrStatus !== "done" ? (
        <EmptyState description="转写完成后才能识别说话人。" />
      ) : candidates.isLoading ? (
        <p className="meta" style={{ fontSize: "var(--text-xs)" }}>正在分析说话人……</p>
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
  // Single shared <audio> element for the whole card grid → guarantees mutual
  // exclusivity (only one clip can sound at a time) for free.
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
    const el = audioRef.current;
    if (el) el.pause();
    setPlaying(null);
  }

  return (
    <>
      <audio
        ref={audioRef}
        preload="none"
        onEnded={() => setPlaying(null)}
        onPause={() => setPlaying(null)}
      />
      <div className="card-grid">
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
  /** Non-null (with the active idx) when THIS tile's audio is sounding. */
  playing: Playing | null;
  onPlay: (idx: number, url: string) => void;
  onStop: () => void;
}) {
  const qc = useQueryClient();
  const samples = candidate.sample_segments;
  const hasSamples = samples.length > 0;

  // Which sample segment this tile is parked on (default 0). Stays put across
  // re-renders so 下一段 walks through the speaker's clips.
  const [idx, setIdx] = useState(0);
  const seg = hasSamples ? samples[Math.min(idx, samples.length - 1)] : null;
  const isPlaying = playing != null;

  // Inline rename state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const nameMut = useMutation({
    mutationFn: (name: string) =>
      nameSpeakerFromRecording({
        recording_id: recordingId,
        speaker: candidate.speaker,
        name,
        update_current_recording: true,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["speaker-candidates", recordingId] });
      qc.invalidateQueries({ queryKey: ["voiceprints"] });
      setEditing(false);
      setHint(res.downgraded ? "发言较短，仅命名未建声纹。" : null);
    },
    onError: (err) => setError(readApiError(err)),
  });

  function startEdit() {
    setError(null);
    setHint(null);
    setDraft(candidate.speaker_name ?? "");
    setEditing(true);
  }

  function commit() {
    // 回车提交后 onSuccess 会卸载输入框，卸载又触发 onBlur —— 两条路径都调
    // commit，于是同一个名字提交两次，建出两个同名声纹。而「名字没变就跳过」
    // 那道判断此时还拦不住：候选数据要等查询刷新回来才更新。
    if (nameMut.isPending) return;
    const name = draft.trim();
    if (!name) {
      // Empty → just cancel the edit, leave the speaker untouched.
      setEditing(false);
      return;
    }
    if (name === candidate.speaker_name) {
      setEditing(false);
      return;
    }
    setError(null);
    nameMut.mutate(name);
  }

  function togglePlay() {
    if (!seg) return;
    if (isPlaying) onStop();
    else onPlay(idx, seg.audio_url);
  }

  function next() {
    if (!hasSamples) return;
    const nextIdx = (idx + 1) % samples.length;
    setIdx(nextIdx);
    // Play the new segment immediately so 下一段 doubles as "听下一段".
    onPlay(nextIdx, samples[nextIdx].audio_url);
  }

  const previewText = seg
    ? (seg.text?.trim() ? seg.text.trim().slice(0, 28) : seg.start_label)
    : "无可试听片段";

  return (
    <div className="card speaker-tile">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        {editing ? (
          <input
            className="input"
            autoFocus
            value={draft}
            disabled={nameMut.isPending}
            placeholder={`Speaker ${candidate.speaker}`}
            style={{ flex: 1, minWidth: 0 }}
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
            style={{
              all: "unset",
              fontWeight: "var(--w-medium)",
              color: candidate.speaker_name ? "var(--ink)" : "var(--ink-3)",
              cursor: "pointer",
              textAlign: "left",
              borderBottom: "1px dashed var(--line)",
            }}
          >
            {candidate.speaker_name ? candidate.speaker_name : `Speaker ${candidate.speaker}`}
          </button>
        )}
        <span className="text-caption" style={{ color: "var(--ink-2)", flexShrink: 0 }}>{candidate.segment_count} 段</span>
      </div>

      {nameMut.isPending && (
        <span className="text-caption" style={{ color: "var(--ink-2)" }}>保存中……</span>
      )}
      {error && (
        <div className="field">
          <span role="alert" className="err">{error}</span>
        </div>
      )}
      {hint && (
        <span className="text-caption" style={{ color: "var(--ink-2)" }}>{hint}</span>
      )}

      <span className="text-caption" style={{ color: "var(--ink-2)" }}>累计 {candidate.total_duration_label}</span>

      {/* 试听控件 */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", minWidth: 0 }}>
        <button
          type="button"
          className="icon-btn"
          aria-label={isPlaying ? "暂停试听" : "播放该说话人片段"}
          aria-pressed={isPlaying}
          disabled={!hasSamples}
          onClick={togglePlay}
        >
          <Icon name={isPlaying ? "pause" : "play"} size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="下一段"
          disabled={!hasSamples || samples.length < 2}
          onClick={next}
        >
          <Icon name="skip-forward" size={16} />
        </button>
        <span
          className="text-caption"
          title={seg?.text ?? undefined}
          style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
        >
          {hasSamples ? `${seg!.start_label} · ${previewText}` : "无可试听片段"}
        </span>
      </div>

      <Status tone={candidate.speaker_name ? "moss" : "muted"}>
        {candidate.speaker_name ? (candidate.voiceprint_id ? "已绑定声纹" : "已命名") : "未命名"}
      </Status>
    </div>
  );
}
