import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createVoiceprint, fetchVoiceprints, patchVoiceprint } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Icon } from "@/components/Icon";
import { Field, FormRow } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";
import { useAuth } from "@/context/auth";
import { formatBytes, formatRelative } from "@/utils/format";

export function Voiceprints() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const voiceprints = useQuery({ queryKey: ["voiceprints"], queryFn: fetchVoiceprints });

  const [showUpload, setShowUpload] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"personal" | "team" | "global">(
    user?.role === "admin" ? "global" : user?.role === "manager" ? "team" : "personal",
  );
  const [threshold, setThreshold] = useState(0.66);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const create = useMutation({
    mutationFn: createVoiceprint,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["voiceprints"] });
      setShowUpload(false);
      setName("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err) => setError(readApiError(err)),
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof patchVoiceprint>[1] }) =>
      patchVoiceprint(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voiceprints"] }),
    onError: (err) => setError(readApiError(err)),
  });

  function onFilePick(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError("先选择一个声纹音频。");
      return;
    }
    if (!name.trim()) {
      setError("请填写说话人姓名。");
      return;
    }
    create.mutate({ name: name.trim(), threshold, scope, file });
  }

  const rows = voiceprints.data ?? [];

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="声纹"
        subtitle={`共 ${rows.length} 个声纹样本。新录音会自动用这些样本标注说话人。`}
        actions={
          <Button variant="primary" size="sm" onClick={() => setShowUpload((v) => !v)}>
            <Icon name="plus" size={14} /> {showUpload ? "收起" : "添加声纹"}
          </Button>
        }
      />

      {error && <Diag code="VP_E_ACTION">{error}</Diag>}

      {showUpload && (
        <form
          onSubmit={handleSubmit}
          className="card"
          style={{ padding: "var(--space-5)", marginBottom: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          <FormRow label="姓名" required>
            <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="如：王晓东" />
          </FormRow>
          <FormRow label="可见范围">
            <select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              {user?.role === "member" && <option value="personal">仅我</option>}
              {(user?.role === "manager" || user?.role === "admin") && <option value="team">团队共享</option>}
              {user?.role === "admin" && <option value="global">全公司</option>}
            </select>
          </FormRow>
          <FormRow label="匹配阈值" hint="0.45–0.95。值越高越严，建议默认 0.66。">
            <input
              type="range"
              min={0.45}
              max={0.95}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <span className="meta" style={{ marginLeft: "var(--space-3)", fontFamily: "var(--font-mono)" }}>
              {threshold.toFixed(2)}
            </span>
          </FormRow>
          <FormRow label="音频文件" required hint="时长不少于 5 秒。.m4a / .mp3 / .wav / .aac">
            <input
              ref={fileInputRef}
              type="file"
              accept=".m4a,.mp3,.wav,.aac,.flac"
              onChange={onFilePick}
              className="field"
            />
            {file && (
              <span className="meta" style={{ marginLeft: "var(--space-3)" }}>
                {file.name} · {formatBytes(file.size)}
              </span>
            )}
          </FormRow>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
            <Button variant="ghost" type="button" onClick={() => setShowUpload(false)}>取消</Button>
            <Button variant="primary" type="submit" loading={create.isPending} disabled={!name.trim() || !file}>
              保存声纹
            </Button>
          </div>
        </form>
      )}

      {voiceprints.isError && <Diag code="VP_E_LIST">{readApiError(voiceprints.error)}</Diag>}
      {rows.length === 0 && !voiceprints.isLoading && !voiceprints.isError && (
        <EmptyState description="还没有声纹。可以从录音详情页的「说话人」里保存一段发言为样本。" />
      )}

      {rows.length > 0 && (
        <ul className="item-list">
          {rows.map((vp) => (
            <li key={vp.id} style={{ padding: "var(--space-4) 0", borderBottom: "1px solid var(--border-default)", display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 500 }}>{vp.name}</p>
                <p className="meta" style={{ fontSize: "var(--text-xs)" }}>
                  {vp.scope === "personal" ? "仅我" : vp.scope === "team" ? "团队共享" : "全公司"} · 阈值 {Number(vp.threshold).toFixed(2)} · 创建 {formatRelative(vp.created_at)}
                </p>
              </div>
              <Status tone={vp.active ? "moss" : "muted"}>{vp.active ? "启用" : "停用"}</Status>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update.mutate({ id: vp.id, payload: { active: vp.active ? 0 : 1 } })}
                >
                  {vp.active ? "停用" : "启用"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
