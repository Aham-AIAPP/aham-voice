import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acceptHotwordSuggestion,
  fetchHotwordSuggestions,
  rejectHotwordSuggestion,
} from "@/api/endpoints";
import { readApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";

/** Pending hotword proposals mined from finished transcripts.
 *
 * Two kinds. A "term" is a proper noun the transcript used that the hotword
 * table never knew about. A "correction" is the more valuable one: the word ASR
 * actually produced, paired with what it should have been — accepting it files
 * the misheard spelling as an alias, so the next transcript gets it right.
 */
export function SuggestionsCard() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const suggestions = useQuery({
    queryKey: ["hotword-suggestions"],
    queryFn: () => fetchHotwordSuggestions("pending"),
  });

  // Both mutations refresh the same two lists; declared separately rather than
  // through a helper so the hooks stay unconditional and in a fixed order.
  const settled = {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotword-suggestions"] });
      qc.invalidateQueries({ queryKey: ["hotwords-all"] });
    },
    onError: (err: unknown) => setError(readApiError(err)),
  };
  const accept = useMutation({ mutationFn: acceptHotwordSuggestion, ...settled });
  const reject = useMutation({ mutationFn: rejectHotwordSuggestion, ...settled });

  const items = suggestions.data ?? [];
  if (!suggestions.isLoading && items.length === 0) return null;

  return (
    <section className="card stack-card">
      <div className="row">
        <h3 className="text-subhead form-section__title">待确认的热词建议</h3>
        <Status tone="amber">{items.length}</Status>
      </div>

      <p className="text-caption t-2" style={{ margin: 0 }}>
        转写完成后从稿子里挖出来的候选。「纠错」类采纳后会把听错的写法记成别名，下次转写就能纠回来。
      </p>

      {items.map((s) => (
        <div key={s.id} className="row" style={{ alignItems: "flex-start", gap: "var(--s3)" }}>
          <Status tone={s.kind === "correction" ? "amber" : "neutral"}>
            {s.kind === "correction" ? "纠错" : "新词"}
          </Status>
          <div style={{ display: "grid", gap: 2, flex: 1 }}>
            <span className="text-body">
              {s.kind === "correction" ? (
                <>
                  <span style={{ textDecoration: "line-through", opacity: 0.6 }}>{s.heard}</span>
                  {" → "}
                  {s.suggested}
                </>
              ) : (
                s.suggested
              )}
            </span>
            <span className="text-caption t-2">
              {s.reason}
              {s.recording_title ? ` · 来自《${s.recording_title}》` : ""}
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={() => { setError(null); accept.mutate(s.id); }}>
            采纳
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { setError(null); reject.mutate(s.id); }}>
            忽略
          </Button>
        </div>
      ))}

      {error && <Diag code="SUG_E">{error}</Diag>}
    </section>
  );
}
