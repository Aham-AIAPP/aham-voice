import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createVoiceprintFromRecording,
  fetchSpeakerCandidates,
  fetchVoiceprints,
  mergeSpeakers,
  renameSpeaker,
  segmentAudioUrl,
} from "@/api/endpoints";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Diag } from "@/components/Diag";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { readApiError } from "@/api/client";
import { cn } from "@/utils/cn";
import type { SpeakerCandidate } from "@/api/types";

interface Props {
  recordingId: string;
  asrStatus: string;
  /** Optional: auto-open the editor for this speaker id when the panel mounts. */
  initialSpeaker?: string;
}

function QualityChip({ quality }: { quality: "good" | "usable" | "short" }) {
  const tone = quality === "good" ? "moss" : quality === "usable" ? "amber" : "muted";
  const label = quality === "good" ? "推荐" : quality === "usable" ? "可用" : "偏短";
  return <span className={`status status--${tone}`} style={{ fontSize: "var(--text-2xs)" }}>{label}</span>;
}

export function SpeakersPanel({ recordingId, asrStatus, initialSpeaker }: Props) {
  const qc = useQueryClient();
  const candidates = useQuery({
    queryKey: ["speaker-candidates", recordingId],
    queryFn: () => fetchSpeakerCandidates(recordingId),
    enabled: asrStatus === "done",
  });
  const voiceprints = useQuery({
    queryKey: ["voiceprints"],
    queryFn: () => fetchVoiceprints(),
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState<string>("");
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [saveVoiceprint, setSaveVoiceprint] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Single shared audio element — clicking any ▶ plays that clip, clicking the
  // active one (or another) pauses/switches. No native <audio controls> bars.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  function togglePlay(url: string) {
    const el = audioRef.current;
    if (!el) return;
    if (playingUrl === url) {
      el.pause();
      setPlayingUrl(null);
      return;
    }
    el.src = url;
    el.play().then(() => setPlayingUrl(url)).catch(() => setPlayingUrl(null));
  }

  // Auto-open the editor for a pre-selected speaker once candidates load.
  useEffect(() => {
    if (!initialSpeaker || !candidates.data) return;
    const match = candidates.data.find((c) => c.speaker === initialSpeaker);
    if (!match) return;
    setEditing(initialSpeaker);
    setName(match.speaker_name ?? "");
    setProfileId(match.voiceprint_id ?? "");
    setSelectedSegments([]);
    setSaveVoiceprint(false);
    setMergeTarget("");
  }, [initialSpeaker, candidates.data]);

  const rename = useMutation({
    mutationFn: (payload: { speaker: string; name: string; voiceprint_id?: string }) =>
      renameSpeaker(recordingId, payload.speaker, { name: payload.name, voiceprint_id: payload.voiceprint_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["speaker-candidates", recordingId] });
      setEditing(null);
    },
    onError: (err) => setError(readApiError(err)),
  });

  const saveAsVoiceprint = useMutation({
    mutationFn: (payload: { speaker: string; name: string; segment_ids: string[]; profile_id?: string }) =>
      createVoiceprintFromRecording({
        recording_id: recordingId,
        speaker: payload.speaker,
        name: payload.name,
        segment_ids: payload.segment_ids,
        profile_id: payload.profile_id || undefined,
        update_current_recording: true,
        scope: "team",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["speaker-candidates", recordingId] });
      qc.invalidateQueries({ queryKey: ["voiceprints"] });
      setEditing(null);
    },
    onError: (err) => setError(readApiError(err)),
  });

  const merge = useMutation({
    mutationFn: (payload: { from: string; into: string }) =>
      mergeSpeakers(recordingId, payload.from, payload.into),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["speaker-candidates", recordingId] });
      setEditing(null);
      setMergeTarget("");
    },
    onError: (err) => setError(readApiError(err)),
  });

  function startEdit(candidate: SpeakerCandidate) {
    setError(null);
    setEditing(candidate.speaker);
    setName(candidate.speaker_name ?? "");
    setProfileId(candidate.voiceprint_id ?? "");
    setSelectedSegments([]);
    setSaveVoiceprint(false);
    setMergeTarget("");
  }

  function handleSave(candidate: SpeakerCandidate) {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("说话人姓名不能为空。");
      return;
    }
    if (saveVoiceprint) {
      const segmentIds = selectedSegments.length > 0
        ? selectedSegments
        : candidate.sample_segments.slice(0, 4).map((s) => s.id);
      saveAsVoiceprint.mutate({ speaker: candidate.speaker, name: trimmed, segment_ids: segmentIds, profile_id: profileId });
    } else {
      rename.mutate({ speaker: candidate.speaker, name: trimmed, voiceprint_id: profileId });
    }
  }

  if (asrStatus !== "done") return <EmptyState description="转写完成后才能查看说话人。" />;
  if (candidates.isLoading) return <EmptyState description="正在分析说话人……" />;
  if (candidates.isError) return <Diag code="SPK_E_LIST">{readApiError(candidates.error)}</Diag>;
  if (!candidates.data || candidates.data.length === 0) {
    return <EmptyState description="本次转写没有识别出任何说话人。" />;
  }

  const allCandidates = candidates.data;
  const availableProfiles = voiceprints.data ?? [];
  const saving = rename.isPending || saveAsVoiceprint.isPending;

  function PlayButton({ id, size = 14 }: { id: string; size?: number }) {
    const url = segmentAudioUrl(recordingId, id);
    return (
      <button type="button" className="spk-play" aria-label="试听" onClick={() => togglePlay(url)}>
        <Icon name={playingUrl === url ? "pause" : "play"} size={size} />
      </button>
    );
  }

  return (
    <div className="spk-panel">
      <audio ref={audioRef} onEnded={() => setPlayingUrl(null)} hidden />
      {error && <Diag code="SPK_E_RENAME">{error}</Diag>}
      <p className="spk-hint">先试听认人 → 命名；同一个人被拆成多个，就用「合并到…」并到一起。已按说话时长从多到少排列。</p>

      <ul className="spk-list">
        {allCandidates.map((candidate) => {
          const isEditing = editing === candidate.speaker;
          const best = candidate.sample_segments[0];
          return (
            <li key={candidate.speaker} className={cn("spk-row-wrap", isEditing && "is-editing")}>
              <div className="spk-row">
                <Avatar name={candidate.display_name} size="sm" />
                <div className="spk-row__main">
                  <p className="spk-row__name">
                    {candidate.display_name}
                    {candidate.voiceprint_id ? <span className="spk-row__tag">已绑声纹</span> : null}
                  </p>
                  <p className="spk-row__meta">
                    {candidate.segment_count} 段 · 累计 {candidate.total_duration_label}
                    {!candidate.speaker_name ? " · 未命名" : ""}
                  </p>
                </div>
                {best && <PlayButton id={best.id} />}
                <Button variant="ghost" size="sm" onClick={() => (isEditing ? setEditing(null) : startEdit(candidate))}>
                  {isEditing ? "收起" : candidate.speaker_name ? "重命名" : "命名"}
                </Button>
              </div>

              {isEditing && (
                <div className="spk-editor">
                  {candidate.sample_segments.length > 0 && (
                    <div className="spk-editor__section">
                      <p className="spk-editor__label">试听代表片段</p>
                      <ul className="spk-clips">
                        {candidate.sample_segments.slice(0, 3).map((seg) => (
                          <li key={seg.id} className="spk-clip">
                            <PlayButton id={seg.id} size={13} />
                            <span className="spk-clip__time">{seg.start_label}</span>
                            <span className="spk-clip__text">{seg.text}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="spk-editor__section">
                    <p className="spk-editor__label">命名</p>
                    <div className="spk-fields">
                      <label className="spk-field">
                        <span>姓名</span>
                        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：朱涛" />
                      </label>
                      <label className="spk-field">
                        <span>关联声纹（可选，选后立即回填本录音）</span>
                        <select className="field" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                          <option value="">不关联</option>
                          {availableProfiles.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}（{p.scope}）</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="spk-check">
                      <input type="checkbox" checked={saveVoiceprint} onChange={(e) => setSaveVoiceprint(e.target.checked)} />
                      <span>同时把本次发言存为团队声纹样本（以后自动认人）</span>
                    </label>
                    {saveVoiceprint && (
                      <ul className="spk-samples">
                        {candidate.sample_segments.map((seg) => (
                          <li key={seg.id} className="spk-sample">
                            <input
                              type="checkbox"
                              checked={selectedSegments.includes(seg.id)}
                              onChange={(e) =>
                                setSelectedSegments((prev) =>
                                  e.target.checked ? [...prev, seg.id] : prev.filter((x) => x !== seg.id),
                                )
                              }
                            />
                            <PlayButton id={seg.id} size={12} />
                            <span className="spk-clip__text">{seg.text}</span>
                            <QualityChip quality={seg.quality} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {saveVoiceprint && selectedSegments.length === 0 && (
                      <p className="spk-editor__note">未勾选则自动取前几段质量较好的。</p>
                    )}
                  </div>

                  <div className="spk-editor__section spk-editor__merge">
                    <p className="spk-editor__label">这其实是另一个人？</p>
                    <div className="spk-merge-row">
                      <select className="field" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
                        <option value="">合并到…</option>
                        {allCandidates
                          .filter((c) => c.speaker !== candidate.speaker)
                          .map((c) => (
                            <option key={c.speaker} value={c.speaker}>
                              {c.display_name}（{c.segment_count} 段）
                            </option>
                          ))}
                      </select>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!mergeTarget || merge.isPending}
                        loading={merge.isPending}
                        onClick={() => merge.mutate({ from: candidate.speaker, into: mergeTarget })}
                      >
                        合并
                      </Button>
                    </div>
                  </div>

                  <div className="spk-editor__bar">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
                    <Button variant="primary" size="sm" loading={saving} disabled={!name.trim()} onClick={() => handleSave(candidate)}>
                      保存
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
