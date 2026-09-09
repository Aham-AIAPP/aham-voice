import { recordingAudioUrl } from "@/api/endpoints";
import { AudioPlayer } from "@/components/voice/AudioPlayer";
import { Status } from "@/components/Status";
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
    <section className="card stack-card">
      <header className="row" style={{ flexWrap: "wrap", gap: "var(--s2)", alignItems: "baseline" }}>
        <span className="ftype">录音</span>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--w-medium)" }}>{recording.filename}</span>
        <span className="text-caption">{recording.duration_label}</span>
      </header>

      <AudioPlayer
        src={recordingAudioUrl(recording.id)}
        seed={recording.id}
        ariaLabel="录音"
      />

      <div
        className="card-grid"
        style={{
          marginTop: "var(--s1)",
          // Three compact tiles aligned to the start instead of stretching
          // across a wide card (#50); a min tile width keeps them grouped.
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          maxWidth: "480px",
        }}
      >
        <div className="metric">
          <span className="k">热词</span>
          <Status tone={hotwordsEnabled ? "moss" : "muted"}>
            {hotwordsEnabled ? `已启用 · ${hotwordPackage!.asr_terms_count} 条` : "暂未启用"}
          </Status>
        </div>
        <div className="metric">
          <span className="k">声纹</span>
          <Status tone={voiceprintMatched > 0 ? "moss" : "muted"}>
            {speakerTotal === 0
              ? "—"
              : voiceprintMatched > 0
                ? `已匹配 ${voiceprintMatched}/${speakerTotal}`
                : "待匹配"}
          </Status>
        </div>
        <div className="metric">
          <span className="k">说话人</span>
          <Status tone={speakerTotal > 0 ? "moss" : "muted"}>
            {speakerTotal > 0 ? `${speakerTotal} 位` : "—"}
          </Status>
        </div>
      </div>
    </section>
  );
}
