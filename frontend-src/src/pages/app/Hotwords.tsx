import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchHotwordStatus,
  fetchHotwords,
  maintainHotwords,
  patchHotword,
  syncHotwordSource,
} from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Icon } from "@/components/Icon";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { readApiError } from "@/api/client";
import { useAuth } from "@/context/auth";
import { formatRelative } from "@/utils/format";

const STATES = ["全部", "active", "expired", "protected"] as const;

export function Hotwords() {
  const { user } = useAuth();
  const canSync = user?.role === "admin" || user?.role === "manager";
  const qc = useQueryClient();

  const [state, setState] = useState<string>("全部");
  const [q, setQ] = useState("");
  const [protectedOnly, setProtectedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const status = useQuery({ queryKey: ["hotwords-status"], queryFn: fetchHotwordStatus });
  const rows = useQuery({
    queryKey: ["hotwords", state, q, protectedOnly],
    queryFn: () =>
      fetchHotwords({
        state: state === "全部" ? "" : state,
        q,
        protected: protectedOnly ? "1" : undefined,
      }),
  });

  const togglePatch = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof patchHotword>[1] }) =>
      patchHotword(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hotwords"] });
      qc.invalidateQueries({ queryKey: ["hotwords-status"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  const sync = useMutation({
    mutationFn: (input: { source: "all" | "crm" | "wecom-journals"; preview: boolean }) =>
      syncHotwordSource(input.source, input.preview),
    onSuccess: (data, vars) => {
      const r = (data.results?.[0] ?? {}) as Record<string, unknown>;
      setInfo(
        `${vars.source === "wecom-journals" ? "企微" : vars.source === "crm" ? "CRM" : "全部"}${vars.preview ? " · 预演" : ""}：新增 ${r.inserted ?? 0}，更新 ${r.updated ?? 0}，重激活 ${r.reactivated ?? 0}，过期 ${r.expired ?? 0}`,
      );
      qc.invalidateQueries({ queryKey: ["hotwords"] });
      qc.invalidateQueries({ queryKey: ["hotwords-status"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  const maintain = useMutation({
    mutationFn: maintainHotwords,
    onSuccess: (data) => {
      setInfo(`已重算评分。过期 ${data.expired}，更新 ${data.rescored}。`);
      qc.invalidateQueries({ queryKey: ["hotwords"] });
      qc.invalidateQueries({ queryKey: ["hotwords-status"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="热词"
        subtitle={
          status.data
            ? `共 ${status.data.total} 条 · 启用 ${status.data.active} · 受保护 ${status.data.protected} · 已过期 ${status.data.expired}`
            : "加载中…"
        }
        actions={
          canSync ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                loading={maintain.isPending}
                onClick={() => {
                  setError(null);
                  setInfo(null);
                  maintain.mutate();
                }}
              >
                重算评分
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={sync.isPending}
                onClick={() => {
                  setError(null);
                  setInfo(null);
                  sync.mutate({ source: "all", preview: false });
                }}
              >
                <Icon name="refresh-cw" size={14} /> 同步全部
              </Button>
            </>
          ) : undefined
        }
      />

      {error && <Diag code="HW_E_ACTION">{error}</Diag>}
      {info && <Diag code="HW_OK" tone="info">{info}</Diag>}

      {canSync && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <Button variant="ghost" size="sm" onClick={() => sync.mutate({ source: "crm", preview: true })} loading={sync.isPending}>
            预演 · CRM
          </Button>
          <Button variant="ghost" size="sm" onClick={() => sync.mutate({ source: "crm", preview: false })} loading={sync.isPending}>
            同步 · CRM
          </Button>
          <Button variant="ghost" size="sm" onClick={() => sync.mutate({ source: "wecom-journals", preview: true })} loading={sync.isPending}>
            预演 · 企微日报
          </Button>
          <Button variant="ghost" size="sm" onClick={() => sync.mutate({ source: "wecom-journals", preview: false })} loading={sync.isPending}>
            同步 · 企微日报
          </Button>
        </div>
      )}

      {status.data && status.data.recent_runs.length > 0 && (
        <details style={{ marginBottom: "var(--space-4)" }}>
          <summary>最近 {status.data.recent_runs.length} 次同步</summary>
          <ul className="item-list" style={{ marginTop: "var(--space-2)" }}>
            {status.data.recent_runs.map((run) => (
              <li key={run.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)", display: "flex", gap: "var(--space-3)" }}>
                <span style={{ minWidth: 160 }}>{run.source_name}</span>
                <Status tone={run.status === "done" ? "moss" : run.status === "running" ? "accent" : "rust"}>
                  {run.status}
                </Status>
                <span className="meta" style={{ fontSize: "var(--text-xs)" }}>
                  新 {run.inserted} · 改 {run.updated} · 重激活 {run.reactivated} · 过期 {run.expired} · 跳 {run.skipped}
                </span>
                <span className="meta" style={{ fontSize: "var(--text-xs)", marginLeft: "auto" }}>
                  {formatRelative(run.started_at)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="filter-bar">
        <div className="filter-bar__search">
          <Icon name="search" size={14} className="filter-bar__search-icon" />
          <input
            type="search"
            placeholder="搜索词、别名、来源、类别"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="filter-bar__segments" role="tablist" aria-label="状态">
          {STATES.map((s) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => setState(s)}>
              {s === "active" ? "启用中" : s === "expired" ? "已过期" : s === "protected" ? "保护" : "全部"}
            </button>
          ))}
        </div>
        <label style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
          <input type="checkbox" checked={protectedOnly} onChange={(e) => setProtectedOnly(e.target.checked)} />
          <span className="meta">仅看受保护</span>
        </label>
      </div>

      {rows.isError && <Diag code="HW_E_LIST">{readApiError(rows.error)}</Diag>}
      {rows.data && rows.data.length === 0 && !rows.isLoading && (
        <EmptyState description="当前筛选下没有任何热词。" />
      )}

      {rows.data && rows.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-grow">词</th>
              <th className="col-fit">类型</th>
              <th className="col-fit">别名</th>
              <th className="col-fit">来源</th>
              <th className="col-fit">权重</th>
              <th className="col-fit">命中</th>
              <th className="col-fit">状态</th>
              <th className="col-fit">最近</th>
              {canSync && <th className="col-fit">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.data.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="cell-stack">
                    <span className="primary">{row.word}</span>
                    {row.protected && <span className="meta" style={{ fontSize: "var(--text-2xs)" }}>受保护</span>}
                  </div>
                </td>
                <td className="cat">{row.kind}</td>
                <td className="meta" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.aliases || "—"}
                </td>
                <td className="meta">{row.source}</td>
                <td className="meta">{row.weight}</td>
                <td className="meta">{row.hit_count}</td>
                <td>
                  <Status
                    tone={
                      row.state === "expired"
                        ? "muted"
                        : row.protected
                          ? "accent"
                          : row.active
                            ? "moss"
                            : "rust"
                    }
                  >
                    {row.state === "expired" ? "已过期" : row.active ? (row.protected ? "保护" : "启用") : "停用"}
                  </Status>
                </td>
                <td className="meta">{formatRelative(row.last_seen_at)}</td>
                {canSync && (
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        togglePatch.mutate({
                          id: row.id,
                          payload: { protected: !row.protected },
                        })
                      }
                    >
                      {row.protected ? "取消保护" : "标为保护"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.data && rows.data.length > 0 && (
        <div className="list-footer">
          <span className="count">共 {rows.data.length} 条（最多展示 1000 条）</span>
        </div>
      )}
    </div>
  );
}
