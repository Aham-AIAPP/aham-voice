import { useEffect, useState } from "react";
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
import { Field, FormRow } from "@/components/Field";
import { readApiError } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import type { SpeakerCandidate } from "@/api/types";

interface Props {
  recordingId: string;
  asrStatus: string;
  /** Optional: auto-open the editor for this speaker id when the panel mounts.
   *  Used when entering the drawer by clicking a specific speaker tile. */
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

  // Auto-open the editor for a specific speaker when the drawer mounts with one
  // pre-selected. Only fires once the candidates have loaded so the row exists.
  useEffect(() => {
    if (!initialSpeaker) return;
    if (!candidates.data) return;
    const match = candidates.data.find((c) => c.speaker === initialSpeaker);
    if (!match) return;
    setEditing(initialSpeaker);
    setName(match.speaker_name ?? "");
    setProfileId(match.voiceprint_id ?? "");
    setSelectedSegments([]);
    setSaveVoiceprint(false);
  }, [initialSpeaker, candidates.data]);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState<string>("");
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [saveVoiceprint, setSaveVoiceprint] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

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
      saveAsVoiceprint.mutate({
        speaker: candidate.speaker,
        name: trimmed,
        segment_ids: segmentIds,
        profile_id: profileId,
      });
    } else {
      rename.mutate({ speaker: candidate.speaker, name: trimmed, voiceprint_id: profileId });
    }
  }

  if (asrStatus !== "done") {
    return <EmptyState description="转写完成后才能查看说话人。" />;
  }

  if (candidates.isLoading) return <EmptyState description="正在分析说话人……" />;
  if (candidates.isError) return <Diag code="SPK_E_LIST">{readApiError(candidates.error)}</Diag>;
  if (!candidates.data || candidates.data.length === 0) {
    return <EmptyState description="本次转写没有识别出任何说话人。" />;
  }

  const availableProfiles = voiceprints.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {error && <Diag code="SPK_E_RENAME">{error}</Diag>}
      <ul className="item-list">
        {candidates.data.map((candidate) => (
          <li key={candidate.speaker} style={{ padding: "var(--space-5) 0", borderBottom: "1px solid var(--border-default)" }}>
            <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-start" }}>
              <Avatar name={candidate.display_name} size="md" />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 500 }}>{candidate.display_name}</p>
                <p className="meta" style={{ fontSize: "var(--text-xs)" }}>
                  {candidate.segment_count} 段发言 · 累计 {candidate.total_duration_label}
                  {candidate.voiceprint_id ? " · 已绑定声纹" : ""}
                </p>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                {editing === candidate.speaker ? (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => startEdit(candidate)}>
                    {candidate.speaker_name ? "重命名" : "命名 / 关联声纹"}
                  </Button>
                )}
              </div>
            </div>

            {editing === candidate.speaker && (
              <div style={{ marginTop: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", maxWidth: 560 }}>
                {candidate.sample_segments.length > 0 && (
                  <div>
                    <p className="meta" style={{ fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
                      试听代表片段，听出是谁再命名：
                    </p>
                    <ul style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                      {candidate.sample_segments.slice(0, 3).map((seg) => (
                        <li key={seg.id} style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                          <audio controls preload="none" src={segmentAudioUrl(recordingId, seg.id)} style={{ height: 32, flexShrink: 0 }} />
                          <span className="meta" style={{ fontSize: "var(--text-2xs)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {seg.start_label} · {seg.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <FormRow label="姓名" required>
                  <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="如：王晓东" />
                </FormRow>
                <FormRow label="关联声纹" optional hint="选择已有声纹会立即更新本录音中的所有该说话人发言。">
                  <select className="field" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                    <option value="">不关联</option>
                    {availableProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}（{p.scope}）</option>
                    ))}
                  </select>
                </FormRow>
                <label style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={saveVoiceprint}
                    onChange={(e) => setSaveVoiceprint(e.target.checked)}
                  />
                  <span>同时把本次的发言保存为团队声纹样本</span>
                </label>
                {saveVoiceprint && (
                  <div>
                    <p className="meta" style={{ fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
                      勾选要纳入声纹的样本（不选则自动取前几段质量较好的）。
                    </p>
                    <ul className="item-list" style={{ borderTop: "1px solid var(--border-default)" }}>
                      {candidate.sample_segments.map((seg) => (
                        <li key={seg.id} style={{ padding: "var(--space-3) 0", borderBottom: "1px solid var(--border-default)", display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
                          <input
                            type="checkbox"
                            checked={selectedSegments.includes(seg.id)}
                            onChange={(e) =>
                              setSelectedSegments((prev) =>
                                e.target.checked ? [...prev, seg.id] : prev.filter((id) => id !== seg.id),
                              )
                            }
                          />
                          <div style={{ flex: 1 }}>
                            <p style={{ fontSize: "var(--text-sm)" }}>{seg.text}</p>
                            <p className="meta" style={{ fontSize: "var(--text-2xs)" }}>
                              {seg.start_label} · {seg.duration_label} · <QualityChip quality={seg.quality} />
                            </p>
                          </div>
                          <audio controls preload="none" src={segmentAudioUrl(recordingId, seg.id)} style={{ height: 24 }} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "var(--space-3)", display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <span className="meta" style={{ fontSize: "var(--text-xs)" }}>这个说话人被拆多了？合并到：</span>
                  <select
                    className="field"
                    style={{ width: 210 }}
                    value={mergeTarget}
                    onChange={(e) => setMergeTarget(e.target.value)}
                  >
                    <option value="">选另一个说话人</option>
                    {candidates.data
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

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={rename.isPending || saveAsVoiceprint.isPending}
                    disabled={!name.trim()}
                    onClick={() => handleSave(candidate)}
                  >
                    保存
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
