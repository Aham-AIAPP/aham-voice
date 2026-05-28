import { useQuery } from "@tanstack/react-query";
import { fetchSpeakerCandidates } from "@/api/endpoints";
import { EmptyState } from "@/components/EmptyState";
import { Status } from "@/components/Status";

interface Props {
  recordingId: string;
  asrStatus: string;
  onPickSpeaker: (speaker: string) => void;
}

// Left-column "从当前录音指定声纹" card. Just a grid of clickable speaker
// tiles — the actual rename / save-voiceprint UX lives in the right drawer
// (SpeakersPanel). Clicking a tile passes the speaker id up so the page can
// open the drawer focused on that speaker.
export function SpeakersCard({ recordingId, asrStatus, onPickSpeaker }: Props) {
  const candidates = useQuery({
    queryKey: ["speaker-candidates", recordingId],
    queryFn: () => fetchSpeakerCandidates(recordingId),
    enabled: asrStatus === "done",
  });

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <header>
        <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", margin: 0 }}>
          从当前录音指定声纹
        </h3>
        <p className="meta" style={{ fontSize: "var(--text-xs)", color: "var(--fg-subtle)", marginTop: "var(--space-1)" }}>
          点击某个说话人，试听代表片段后保存为声纹，当前录音会立即回填真实姓名。
        </p>
      </header>

      {asrStatus !== "done" ? (
        <EmptyState description="转写完成后才能识别说话人。" />
      ) : candidates.isLoading ? (
        <p className="meta" style={{ fontSize: "var(--text-xs)" }}>正在分析说话人……</p>
      ) : !candidates.data || candidates.data.length === 0 ? (
        <EmptyState description="本次转写没有识别出任何说话人。" />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          {candidates.data.map((c) => (
            <button
              key={c.speaker}
              type="button"
              className="speaker-tile"
              onClick={() => onPickSpeaker(c.speaker)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="speaker-tile__title">
                  {c.speaker_name ? c.speaker_name : `Speaker ${c.speaker}`}
                </span>
                <span className="speaker-tile__meta">{c.segment_count} 段</span>
              </div>
              <span className="speaker-tile__meta">累计 {c.total_duration_label}</span>
              <Status tone={c.speaker_name ? "moss" : "muted"}>
                {c.speaker_name ? (c.voiceprint_id ? "已绑定声纹" : "已命名") : "未命名"}
              </Status>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
