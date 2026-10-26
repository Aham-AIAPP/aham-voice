import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewSummaryRevision, applySummaryRevision } from "@/api/endpoints";
import type { SummaryRevisionDraft } from "@/api/types";
import { Button } from "@/components/Button";
import { Textarea } from "@/components/Field";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";

interface Props {
  recordingId: string;
  currentSummaryId: string;
  onPreviewChange: (open: boolean) => void;
  disabled: boolean;
  disabledReason?: string;
}

export function ReviseComposer({ recordingId, currentSummaryId, onPreviewChange, disabled, disabledReason }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<SummaryRevisionDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => onPreviewChange(false), [onPreviewChange]);
  const stale = !!draft && draft.base_summary_id !== currentSummaryId;
  const preview = useMutation({
    mutationFn: () => previewSummaryRevision(recordingId, text.trim()),
    onSuccess: data => { setDraft(data); onPreviewChange(true); requestAnimationFrame(() => previewRef.current?.focus()); },
    onError: err => setError(readApiError(err)),
    onSettled: () => { pendingRef.current = false; },
  });
  const apply = useMutation({
    mutationFn: (id: string) => applySummaryRevision(recordingId, id),
    onSuccess: () => {
      setDraft(null); onPreviewChange(false); setText("");
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      requestAnimationFrame(() => textRef.current?.focus());
    },
    onError: err => setError(readApiError(err)),
    onSettled: () => { pendingRef.current = false; },
  });
  function submit(event: FormEvent | KeyboardEvent) {
    event.preventDefault();
    if (!text.trim() || disabled || pendingRef.current || draft) return;
    pendingRef.current = true; setError(null); preview.mutate();
  }
  function discard() {
    setDraft(null); onPreviewChange(false); setError(null);
    requestAnimationFrame(() => textRef.current?.focus());
  }
  return <div className="rev-composer-form">
    {error && <Diag code="SUM_E_REVISE">{error}</Diag>}
    {draft ? <section className="revision-preview" aria-labelledby="revision-preview-title">
      <h3 id="revision-preview-title" tabIndex={-1} ref={previewRef}>改写预览 · 待你确认</h3>
      <p className="record-source">AI 生成 · {draft.model} · <a href="#record-transcript">查看逐字稿依据</a></p>
      <p className="revision-request"><span>修改要求</span>{text.trim()}</p>
      <details className="record-fold"><summary>对照改写前的纪要</summary><article className="markdown record-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.base_content}</ReactMarkdown></article></details>
      <article className="markdown record-prose revision-draft"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.content}</ReactMarkdown></article>
      <p className="record-muted" role="status">{stale ? '当前纪要已有更新，请重新生成预览。' : '确认后保存为新版本，原版保留。取消后当前纪要不变。'}</p>
      <div className="composer-row">
        <Button size="sm" disabled={apply.isPending} onClick={discard}>{stale ? '重新修改' : '取消改写'}</Button>
        <Button variant="primary" size="sm" disabled={disabled || stale || apply.isPending} loading={apply.isPending} onClick={() => {
          if (pendingRef.current) return;
          pendingRef.current = true; setError(null); apply.mutate(draft.draft_id);
        }}>确认应用改写</Button>
      </div>
    </section> : <form onSubmit={submit} className="composer u-pad-3-4">
      <Textarea ref={textRef} aria-label="纪要修改要求" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
      }} placeholder={disabled ? disabledReason ?? '处理完成后可以修改纪要' : '改一下：按议题整理、补充行动项、保留时间戳……'} rows={3} disabled={disabled || preview.isPending} />
      <div className="composer-row"><span className="meta u-fs-2xs u-fg-subtle">先预览，确认后再保存为新版本</span>
        <Button type="submit" variant="secondary" size="sm" loading={preview.isPending} disabled={disabled || !text.trim()}>生成改写预览</Button>
      </div>
    </form>}
  </div>;
}
