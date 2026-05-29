import { useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { uploadRecording } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Field, FormRow } from "@/components/Field";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";
import { formatBytes } from "@/utils/format";
import { cn } from "@/utils/cn";

const MEETING_TYPES = ["内部会议", "客户调研", "方案汇报", "销售电话"];
const ACCEPTED = ".m4a,.mp3,.wav,.aac,.flac,.amr,.opus,.mp4,.wma";

export function RecordingNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [meetingType, setMeetingType] = useState(MEETING_TYPES[0]);
  const [tag, setTag] = useState("");
  const [autoProcess, setAutoProcess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const mutation = useMutation({
    mutationFn: uploadRecording,
    onSuccess: (rec) => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
      navigate(`/app/recordings/${rec.id}`, { replace: true });
    },
    onError: (err) => {
      setError(readApiError(err));
      setUploadPct(null);
    },
  });

  function onFile(f: File | null) {
    setFile(f);
    if (f && !title.trim()) {
      const stem = f.name.replace(/\.[^.]+$/, "");
      setTitle(stem);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) onFile(dropped);
  }

  function onPickInput(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    onFile(picked);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError("先选择一个音频文件。");
      return;
    }
    if (!title.trim()) {
      setError("给录音起一个标题。");
      return;
    }
    setUploadPct(0);
    mutation.mutate({
      file,
      title: title.trim(),
      meeting_type: meetingType,
      tag: tag.trim(),
      auto_process: autoProcess,
      onProgress: (p) => setUploadPct(p),
    });
  }

  return (
    <div className="page-body page--object-index" style={{ maxWidth: "var(--container-page-narrow)" }}>
      <PageHead
        title="上传录音"
        subtitle="文件大小最多 2GB。上传完成后默认自动转写并生成纪要。"
      />

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
        <label
          className={cn("upload-zone", dragOver && "is-active", file && "has-file")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            onChange={onPickInput}
            style={{ position: "absolute", left: -9999, width: 1, height: 1 }}
          />
          <div className="upload-zone__drop">
            {file ? (
              <>
                <p className="upload-zone__primary">{file.name}</p>
                <p className="upload-zone__hint">
                  {formatBytes(file.size)} · 点击替换或拖拽新的文件
                </p>
              </>
            ) : (
              <>
                <p className="upload-zone__primary">拖拽音频到这里 · 或点击选择</p>
                <p className="upload-zone__hint">
                  支持 <span className="accept">.m4a .mp3 .wav .aac .flac .amr .opus .mp4 .wma</span>
                </p>
              </>
            )}
          </div>
        </label>

        <FormRow label="标题" required htmlFor="rec-title">
          <Field
            id="rec-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
          />
        </FormRow>

        <FormRow label="会议类型" htmlFor="rec-type">
          <select
            id="rec-type"
            className="field"
            value={meetingType}
            onChange={(e) => setMeetingType(e.target.value)}
          >
            {MEETING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormRow>

        <FormRow label="客户 / 项目" optional htmlFor="rec-tag" hint="自由文本。会写入摘要侧栏与 CRM 关联候选。">
          <Field
            id="rec-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="如：浙江南都电源 · 储能项目"
          />
        </FormRow>

        <FormRow label="自动处理" hint="上传后自动转写并调用 DeepSeek 生成纪要。关闭后可手动触发。">
          <label style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoProcess}
              onChange={(e) => setAutoProcess(e.target.checked)}
            />
            <span>上传后立即开始转写</span>
          </label>
        </FormRow>

        {error && <Diag code="REC_E_UPLOAD">{error}</Diag>}

        {mutation.isPending && uploadPct !== null && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-sm)" }}>
              <span>{uploadPct < 100 ? "正在上传…" : "上传完成，正在准备处理…"}</span>
              <span className="meta">{uploadPct}%</span>
            </div>
            <div className="task__bar">
              <div className="task__fill" style={{ width: `${uploadPct}%` }} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => navigate(-1)} type="button" disabled={mutation.isPending}>
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={mutation.isPending}
            disabled={!file || !title.trim()}
          >
            {mutation.isPending
              ? uploadPct !== null && uploadPct < 100
                ? `上传中 ${uploadPct}%`
                : "处理中…"
              : "上传并开始"}
          </Button>
        </div>
      </form>
    </div>
  );
}
