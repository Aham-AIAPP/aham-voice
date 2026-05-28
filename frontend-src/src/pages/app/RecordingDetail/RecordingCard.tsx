import { recordingAudioUrl } from "@/api/endpoints";
import type { Recording, TranscriptSegment, HotwordPackage } from "@/api/types";

interface Props {
  recording: Recording;
  segments: TranscriptSegment[];
  hotwordPackage: HotwordPackage | null;
}

function uniqueSpeakerCount(segments: TranscriptSegment[]): number {
  const set = new Set<string>();
  for (const s of segments) set.add(s.speaker);
  return set.size;
}

function matchedVoiceprintCount(segments: TranscriptSegment[]): number {
  const speakers = new Map<string, boolean>();
  for (const s of segments) {
    if (!speakers.has(s.speaker)) speakers.set(s.speaker, false);
    if (s.voiceprint_id) speakers.set(s.speaker, true);
  }
  let count = 0;
  for (const v of speakers.values()) if (v) count += 1;
  return count;
}

// 录音 card: filename row + native audio player + 3 stat tiles
// (热词 · 已启用/未启用 / 声纹 · 待匹配 N/M / 说话人 · N 位).
export function RecordingCard({ recording, segments, hotwordPackage }: Props) {
  const speakerTotal = uniqueSpeakerCount(segments);
  const voiceprintMatched = matchedVoiceprintCount(segments);
  const hotwordsEnabled = !!hotwordPackage && hotwordPackage.asr_terms_count > 0;

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)" }}>
          录音
        </span>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-medium)" }}>{recording.filename}</span>
        <span className="meta" style={{ fontSize: "var(--text-xs)", color: "var(--fg-subtle)" }}>
          {recording.meeting_type} · {recording.duration_label}
        </span>
      </header>

      <audio
        controls
        preload="metadata"
        src={recordingAudioUrl(recording.id)}
        style={{ width: "100%" }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "var(--space-3)",
          marginTop: "var(--space-1)",
        }}
      >
        <div className="stat-tile">
          <span className="stat-tile__label">热词</span>
          <span className={`stat-tile__value${hotwordsEnabled ? "" : " is-pending"}`}>
            {hotwordsEnabled ? `已启用 · ${hotwordPackage!.asr_terms_count} 条` : "暂未启用"}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">声纹</span>
          <span className={`stat-tile__value${voiceprintMatched > 0 ? "" : " is-pending"}`}>
            {speakerTotal === 0
              ? "—"
              : voiceprintMatched > 0
                ? `已匹配 ${voiceprintMatched}/${speakerTotal}`
                : "待匹配"}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">说话人</span>
          <span className={`stat-tile__value${speakerTotal > 0 ? "" : " is-pending"}`}>
            {speakerTotal > 0 ? `${speakerTotal} 位` : "—"}
          </span>
        </div>
      </div>
    </section>
  );
}
