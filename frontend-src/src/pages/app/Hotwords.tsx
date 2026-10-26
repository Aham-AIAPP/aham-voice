import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { fetchAllHotwordWords, saveAllHotwords } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Diag } from "@/components/Diag";
import { Textarea } from "@/components/Field";
import { readApiError } from "@/api/client";

// 个人热词（对齐 aham-voice 开源版）：一个大文本框，每个词用顿号「、」分隔。
// 读取 → zh 排序 → join；保存 → split → trim → 过滤 → PUT。无表格/权重/别名——
// 那是 admin 团队版（/admin/hotword）的能力。本页只管当前用户自己的个人热词。
const SEP = "、";

function parseWords(value: string): string[] {
  return value.split(SEP).map((w) => w.trim()).filter(Boolean);
}

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
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        setError(err.response.data?.detail ?? readApiError(err));
      } else {
        setError(readApiError(err));
      }
    },
  });

  // 导入 txt：每行一个词，追加到文本框，去重（大小写不敏感），重排。
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setInfo(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const incoming = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const existing = parseWords(value);
      const seen = new Set(existing.map((w) => w.toLowerCase()));
      const merged = [...existing];
      let added = 0;
      for (const w of incoming) {
        const key = w.toLowerCase();
        if (!seen.has(key)) { seen.add(key); merged.push(w); added += 1; }
      }
      setValue(joinWords(merged));
      setInfo(`已从 txt 导入：新增 ${added} 个（文件共 ${incoming.length} 行）。记得点「保存」。`);
    };
    reader.onerror = () => setError("读取文件失败，请重试。");
    reader.readAsText(file);
  }

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="热词"
        subtitle={`共 ${count} 个热词，转写时自动启用。`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Icon name="upload" size={14} /> 导入 txt
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              aria-label="导入热词 txt 文件"
              className="u-hidden"
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
          </>
        }
      />

      {error && <Diag code="HW_E">{error}</Diag>}
      {info && <Diag code="HW_OK" tone="info">{info}</Diag>}

      <Textarea
        aria-label="热词列表（用顿号「、」分隔）"
        className="u-w-full u-mt-3 hw-words-area"
        placeholder="客户名、产品名、专业术语……（用「、」分隔）"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={all.isLoading}
      />
    </div>
  );
}
