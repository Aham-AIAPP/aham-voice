import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAllHotwordWords, saveAllHotwords } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { readApiError } from "@/api/client";
import axios from "axios";

// Personal-mode hotwords: one rich-text box, every word joined by the Chinese
// enumeration comma 「、」. Load → sort (zh) → join; save → split → trim →
// filter → PUT. No table / states / weights / aliases — that was the team build.
const SEP = "、";

// Parse a 「、」-separated box into a clean word array (trimmed, non-empty).
function parseWords(value: string): string[] {
  return value
    .split(SEP)
    .map((w) => w.trim())
    .filter(Boolean);
}

// Build the box string from a word list: locale-sorted (zh), joined by 「、」.
function joinWords(words: string[]): string {
  return [...words].sort((a, b) => a.localeCompare(b, "zh")).join(SEP);
}

export function Hotwords() {
  const qc = useQueryClient();

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const all = useQuery({ queryKey: ["hotwords-all"], queryFn: fetchAllHotwordWords });

  // Seed the box once the server list lands. Re-seed whenever the persisted
  // list changes (e.g. after a save returns the deduped/sorted result).
  useEffect(() => {
    if (all.data) setValue(joinWords(all.data));
  }, [all.data]);

  const count = parseWords(value).length;

  const save = useMutation({
    mutationFn: () => saveAllHotwords(parseWords(value)),
    onSuccess: (data) => {
      setError(null);
      setInfo(`已保存，共 ${data.count} 个热词。`);
      setValue(joinWords(data.words));
      qc.setQueryData<string[]>(["hotwords-all"], data.words);
      qc.invalidateQueries({ queryKey: ["hotwords-all"] });
    },
    onError: (err) => {
      setInfo(null);
      // Surface the backend's 400 `detail` (validation) in place via .alert.
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        setError(err.response.data?.detail ?? readApiError(err));
      } else {
        setError(readApiError(err));
      }
    },
  });

  // Import txt: parse each line into a word, append to the box, dedupe
  // (case-insensitive against what's already present), re-sort.
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file re-fires onChange
    if (!file) return;
    setError(null);
    setInfo(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const incoming = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const existing = parseWords(value);
      const seen = new Set(existing.map((w) => w.toLowerCase()));
      const merged = [...existing];
      let added = 0;
      for (const w of incoming) {
        const key = w.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(w);
          added += 1;
        }
      }
      setValue(joinWords(merged));
      setInfo(`已从 txt 导入：新增 ${added} 个（文件共 ${incoming.length} 行）。记得点「保存」。`);
    };
    reader.onerror = () => setError("读取文件失败，请重试。");
    reader.readAsText(file);
  }

  return (
    <div className="container container--content">
      <div className="page-shell">
        <PageHead
          title="热词"
          subtitle={`共 ${count} 个热词，转写时自动启用。`}
        />

        <div className="page-toolbar">
          <div className="page-toolbar__lead">
            <span className="result-count">共 {count} 个</span>
          </div>
          <div className="page-toolbar__trail">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="upload" size={14} /> 导入 txt
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              aria-label="导入热词 txt 文件"
              style={{ display: "none" }}
              onChange={onPickFile}
            />
            <Button
              variant="primary"
              size="sm"
              loading={save.isPending}
              onClick={() => { setError(null); setInfo(null); save.mutate(); }}
            >
              <Icon name="save" size={14} /> 保存
            </Button>
          </div>
        </div>

        <div className="page-content page-content--stack">
          {error && (
            <div className="alert alert--risk" role="alert">
              <span>{error}</span>
            </div>
          )}
          {info && (
            <div className="alert alert--ok" role="status" aria-live="polite">
              <span>{info}</span>
            </div>
          )}

          <label htmlFor="hotwords-text" className="sr-only">
            热词列表（用顿号「、」分隔）
          </label>
          <textarea
            id="hotwords-text"
            className="textarea"
            aria-label="热词列表（用顿号「、」分隔）"
            style={{ width: "100%", minHeight: 360, boxSizing: "border-box" }}
            placeholder="客户名、产品名、专业术语……（用「、」分隔）"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={all.isLoading}
          />
        </div>
      </div>
    </div>
  );
}
