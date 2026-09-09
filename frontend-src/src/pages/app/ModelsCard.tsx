import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelModelDownload,
  deleteModel,
  downloadAllModels,
  downloadModel,
  fetchModels,
} from "@/api/endpoints";
import type { ModelInfo } from "@/api/types";
import { readApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ConfirmDialog";

function gb(bytes: number): string {
  if (!bytes) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function speed(bps: number): string {
  if (!bps) return "";
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${(bps / 1e3).toFixed(0)} KB/s`;
}

const TONE: Record<string, { tone: "moss" | "muted" | "amber" | "rust"; label: string }> = {
  ready: { tone: "moss", label: "已就绪" },
  downloading: { tone: "amber", label: "下载中" },
  queued: { tone: "muted", label: "排队中" },
  partial: { tone: "rust", label: "不完整" },
  missing: { tone: "muted", label: "未下载" },
};

/** First-run model manager.
 *
 * The app ships without the ~4GB of weights it needs, so this is where they get
 * fetched. Polls while anything is downloading; idle otherwise.
 */
export function ModelsCard() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelInfo | null>(null);

  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => fetchModels(),
    // Only poll while something is moving — no point hammering it at rest.
    refetchInterval: (query) => (query.state.data?.downloading.length ? 1200 : false),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["models"] });
  const fail = (err: unknown) => setError(readApiError(err));

  const startAll = useMutation({
    mutationFn: (includeOptional: boolean) => downloadAllModels(includeOptional),
    onSuccess: invalidate,
    onError: fail,
  });
  const startOne = useMutation({ mutationFn: downloadModel, onSuccess: invalidate, onError: fail });
  const cancelOne = useMutation({ mutationFn: cancelModelDownload, onSuccess: invalidate, onError: fail });
  const removeOne = useMutation({ mutationFn: deleteModel, onSuccess: invalidate, onError: fail });

  const data = models.data;
  const busy = (data?.downloading.length ?? 0) > 0;
  const missingRequired = data?.required_missing ?? [];

  const remaining = useMemo(() => {
    if (!data) return 0;
    return Math.max(0, data.total_bytes - data.local_bytes);
  }, [data]);

  return (
    <section className="card stack-card">
      <div className="row">
        <h3 className="text-subhead form-section__title">本地模型</h3>
        <Status tone={data?.ready ? "moss" : "muted"}>
          {data?.ready ? "转写可用" : missingRequired.length ? "缺必需模型" : "检查中"}
        </Status>
      </div>

      <p className="text-caption t-2" style={{ margin: 0 }}>
        转写、说话人分离、声学情绪全部在本机运行，需要先把模型下载到本机（共约 {gb(data?.total_bytes ?? 0)}，
        其中声学情绪是可选的）。模型来自 ModelScope，下载可中断，续传从已下载的字节继续。
      </p>

      {data?.models.map((m) => {
        const chip = TONE[m.status] ?? TONE.missing;
        const pct = m.progress?.percent ?? (m.total_bytes ? (100 * m.local_bytes) / m.total_bytes : 0);
        return (
          <div key={m.key} style={{ display: "grid", gap: 6 }}>
            <div className="row">
              <span className="text-body">{m.label}</span>
              {!m.required && <Status tone="muted">可选</Status>}
              <Status tone={chip.tone}>{chip.label}</Status>
              <span className="text-caption t-2" style={{ marginInlineStart: "auto" }}>
                {m.status === "ready" ? gb(m.local_bytes) : `${gb(m.local_bytes)} / ${gb(m.total_bytes)}`}
              </span>
            </div>

            <span className="text-caption t-2">{m.purpose}</span>

            {(m.status === "downloading" || m.status === "partial") && (
              <div className="progress" aria-label={`${m.label} 下载进度`}>
                <span className="progress__bar" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
              </div>
            )}

            <div className="row">
              {(m.status === "downloading" || m.status === "queued") && (
                <>
                  <span className="text-caption t-2">
                    {m.status === "queued"
                      ? "排队中，等前一个下完"
                      : `${pct.toFixed(1)}%${m.progress?.speed_bps ? ` · ${speed(m.progress.speed_bps)}` : ""}${
                          m.progress?.current_file ? ` · ${m.progress.current_file}` : ""
                        }`}
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => cancelOne.mutate(m.key)}
                    style={{ marginInlineStart: "auto" }}>
                    取消
                  </Button>
                </>
              )}

              {m.status !== "downloading" && m.status !== "queued" && (
                <>
                  {m.status === "partial" && (
                    <span className="text-caption t-2">
                      文件不完整（{m.missing_files.length} 个），继续下载会补齐
                    </span>
                  )}
                  {m.status !== "ready" && (
                    <Button variant="primary" size="sm" disabled={busy}
                      onClick={() => { setError(null); startOne.mutate(m.key); }}
                      style={{ marginInlineStart: "auto" }}>
                      <Icon name="download" size={14} /> {m.status === "partial" ? "继续下载" : "下载"}
                    </Button>
                  )}
                  {m.status === "ready" && !m.bundled && (
                    <Button variant="secondary" size="sm" disabled={busy}
                      onClick={() => { setError(null); setConfirmDelete(m); }}
                      style={{ marginInlineStart: "auto" }}>
                      删除
                    </Button>
                  )}
                  {m.bundled && (
                    <span className="text-caption t-2" style={{ marginInlineStart: "auto" }}>
                      随应用内置
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}

      <div className="row">
        <Button variant="primary" size="sm" disabled={busy || data?.ready}
          loading={startAll.isPending}
          onClick={() => { setError(null); startAll.mutate(false); }}>
          <Icon name="download" size={14} /> 下载必需模型
        </Button>
        <Button variant="secondary" size="sm" disabled={busy}
          loading={startAll.isPending}
          onClick={() => { setError(null); startAll.mutate(true); }}>
          全部下载（含声学情绪）
        </Button>
        <span className="text-caption t-2" style={{ marginInlineStart: "auto" }}>
          还需下载 {gb(remaining)}
        </span>
      </div>

      {busy && (
        <Diag code="MDL_DL" tone="info">
          下载按顺序进行，一次只下一个——并行只会互相抢带宽。可以关掉这个页面，下载在后台继续。
        </Diag>
      )}
      {!models.isLoading && data && !data.models.some((m) => m.verified) && (
        <Diag code="MDL_OFF" tone="info">
          连不上 ModelScope，暂时无法校验完整性；显示的是本机已有文件的情况。
        </Diag>
      )}
      {error && <Diag code="MDL_E">{error}</Diag>}

      <ConfirmDialog
        open={confirmDelete !== null}
        tone="danger"
        title={`删除模型：${confirmDelete?.label ?? ""}`}
        body={`将从本机删除 ${gb(confirmDelete?.local_bytes ?? 0)} 的模型文件。${
          confirmDelete?.required ? "这是必需模型，删除后无法转写，需要重新下载。" : "删除后对应功能不可用，可随时重新下载。"
        }`}
        confirmText="删除"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) removeOne.mutate(target.key);
        }}
      />
    </section>
  );
}
