import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteRecording, fetchRecordings } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Icon } from "@/components/Icon";
import { Diag } from "@/components/Diag";
import { PageLoading } from "@/components/PageLoading";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";
import { statusLabel, overallLabel } from "@/utils/status";
import type { Recording } from "@/api/types";


// Sortable columns. Each maps to a comparable scalar so the table can be
// sorted with a single shared comparator (string locale-aware, number numeric).
type SortKey = "title" | "duration" | "updated_at";
type SortDir = "asc" | "desc";

function sortValue(rec: Recording, key: SortKey): string | number {
  switch (key) {
    case "duration":
      return rec.duration ?? 0;
    case "updated_at":
      return rec.updated_at ? Date.parse(rec.updated_at) : 0;
    case "title":
    default:
      return (rec[key] ?? "").toString().toLowerCase();
  }
}

function overallStatus(rec: Recording): { tone: React.ComponentProps<typeof Status>["tone"]; label: string } {
  const label = overallLabel(rec.asr_status, rec.summary_status);
  if (rec.asr_status === "failed" || rec.summary_status === "failed") return { tone: "rust", label };
  if (rec.asr_status === "running" || rec.summary_status === "running") return { tone: "accent", label };
  if (rec.asr_status === "queued") return { tone: "slate", label };
  if (rec.asr_status === "done" && rec.summary_status === "done") return { tone: "moss", label };
  if (rec.asr_status === "done") return { tone: "accent", label };
  return { tone: "muted", label };
}

function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
  numeric,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
}) {
  const isActive = active === sortKey;
  return (
    <th
      className={numeric ? "num sortable" : "sortable"}
      aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="caret">{isActive ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );
}

export function RecordingsList() {
  const [q, setQ] = useState("");
  // Controlled table sort. Clicking a sortable header toggles asc/desc, or
  // switches the active column. updated_at defaults to most-recent-first.
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Recording pending deletion; drives the destructive ConfirmDialog.
  const [pendingDelete, setPendingDelete] = useState<Recording | null>(null);
  // Id of the row whose delete is in flight, so only that row's button disables.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["recordings", q],
    queryFn: () => fetchRecordings({ q }),
  });

  // Per-row delete. Confirms, calls the backend, then invalidates every
  // recordings query (across all scope/filter combos) so the list refreshes.
  const remove = useMutation({
    mutationFn: (id: string) => deleteRecording(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
    },
    onSettled: () => setDeletingId(null),
  });

  const rows = query.data ?? [];
  const filtered = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      let cmp: number;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), "zh-Hans-CN");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Time/duration feel natural starting high→low; text starts a→z.
      setSortDir(key === "updated_at" || key === "duration" ? "desc" : "asc");
    }
  }

  const totalLabel = useMemo(() => {
    if (query.isLoading) return "加载中";
    if (filtered.length === 0) return "0 条";
    return `${filtered.length} 条`;
  }, [filtered.length, query.isLoading]);

  return (
    <div className="container container--content">
      <div className="page-shell">
        <PageHead
          title="录音库"
          subtitle={query.isLoading ? "加载中…" : `共 ${filtered.length} 条录音。`}
          actions={
            <Button variant="primary" onClick={() => navigate("/app/recordings/new")}>
              <Icon name="upload" size={14} /> 上传录音
            </Button>
          }
        />

        <div className="page-toolbar">
          <div className="page-toolbar__lead">
            <span className="result-count">{totalLabel}</span>
          </div>
          <div className="page-toolbar__trail">
            <input
              className="input toolbar-search"
              type="search"
              aria-label="搜索录音"
              placeholder="搜索录音…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div className="page-content page-content--stack">
          {query.isError && (
            <Diag
              code="REC_E_LIST"
              detail={readApiError(query.error)}
              actions={
                <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
                  重试
                </Button>
              }
            >
              加载录音失败。请检查网络后重试。
            </Diag>
          )}

          {remove.isError && (
            <div className="alert alert--risk" role="alert">
              <span>删除失败：{readApiError(remove.error)}</span>
            </div>
          )}

          {query.isLoading && <PageLoading />}

          {!query.isError && !query.isLoading && (filtered.length === 0 ? (
            <div className="page-state">
              <Icon name="mic" size={48} className="page-state__icon" />
              <div className="page-state__title">
                {q ? "没有匹配的录音" : "还没有任何录音"}
              </div>
              <p className="page-state__desc">
                {q
                  ? "当前筛选下没有匹配的录音。试试清空筛选条件。"
                  : "还没有任何录音。从右上角上传一段开始。"}
              </p>
              {!q && (
                <div className="page-state__actions">
                  <Link to="/app/recordings/new">
                    <Button variant="primary">上传录音</Button>
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="table-xscroll scroll-shadow">
              <table className="doc-table" data-sortable>
            <thead>
              <tr>
                <SortableTh label="录音" sortKey="title" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="时长" sortKey="duration" active={sortKey} dir={sortDir} onSort={toggleSort} numeric />
                <th>状态</th>
                <SortableTh label="更新" sortKey="updated_at" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((rec) => {
                const overall = overallStatus(rec);
                return (
                  <tr key={rec.id}>
                    <td>
                      <div className="lockup">
                        <div className="lk-body">
                          <Link to={`/app/recordings/${rec.id}`} className="lk-title">{rec.title}</Link>
                          <span className="lk-sub t-2">{rec.filename}</span>
                        </div>
                      </div>
                    </td>
                    <td className="num">{rec.duration_label}</td>
                    <td>
                      <Status tone={overall.tone}>{overall.label}</Status>
                      {rec.asr_status === "done" && rec.summary_status === "running" && (
                        <div className="text-caption t-2">
                          纪要 {statusLabel(rec.summary_status)}
                        </div>
                      )}
                    </td>
                    <td className="cat">{formatRelative(rec.updated_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="删除"
                        title="删除"
                        disabled={remove.isPending && deletingId === rec.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(rec);
                        }}
                      >
                        <Icon name="trash-2" size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
                </tbody>
              </table>
              </div>

              <div className="list-foot">
                <span>共 {filtered.length} 条</span>
              </div>
            </>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        tone="danger"
        title="删除录音"
        body={pendingDelete ? `删除「${pendingDelete.title}」？该操作不可撤销。` : ""}
        confirmText="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            setDeletingId(pendingDelete.id);
            remove.mutate(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
