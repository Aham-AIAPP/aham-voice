import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchTasks } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { EmptyState } from "@/components/EmptyState";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";
import { cn } from "@/utils/cn";

export function Tasks() {
  const query = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchTasks(),
    refetchInterval: 4000,
  });

  const rows = query.data ?? [];
  const active = rows.filter((t) => t.status === "running" || t.status === "queued");
  const recent = rows.filter((t) => t.status === "done" || t.status === "failed").slice(0, 24);

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="任务进度"
        subtitle={`当前 ${active.length} 个进行中，最近完成 ${recent.length} 个。每 4 秒自动刷新。`}
      />

      {query.isError && <Diag code="TASK_E_LIST">{readApiError(query.error)}</Diag>}

      {rows.length === 0 && !query.isLoading && !query.isError && (
        <EmptyState description="没有任何任务。完成一次录音上传后，转写和纪要任务会出现在这里。" />
      )}

      {active.length > 0 && (
        <section style={{ marginBottom: "var(--space-8)" }}>
          <h2 className="form-section__title" style={{ marginBottom: "var(--space-3)" }}>进行中</h2>
          <ul className="item-list">
            {active.map((task) => (
              <li key={task.id}>
                <div className="cell-stack">
                  <span className="primary">
                    {task.recording_id ? (
                      <Link to={`/app/recordings/${task.recording_id}`}>{task.recording_title}</Link>
                    ) : (
                      task.recording_title
                    )}
                  </span>
                  <span className="secondary">{task.step}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1, marginLeft: "var(--space-6)" }}>
                  <div className="task">
                    <div
                      className={cn("task__bar", task.is_stale && "is-indeterminate")}
                    >
                      <div className="task__fill" style={{ width: `${Math.min(100, Math.max(2, task.progress))}%` }} />
                    </div>
                  </div>
                  <span className="meta" style={{ fontSize: "var(--text-xs)" }}>
                    {task.progress}% · 已耗时 {task.elapsed_label}
                    {task.eta_label ? ` · 预计还需 ${task.eta_label}` : ""}
                    {task.is_stale ? " · 长时间无更新" : ""}
                  </span>
                </div>
                <Status tone={task.status === "queued" ? "slate" : "accent"}>
                  {task.status === "queued" ? "排队" : "进行"}
                </Status>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="form-section__title" style={{ marginBottom: "var(--space-3)" }}>最近完成</h2>
          <ul className="item-list">
            {recent.map((task) => (
              <li key={task.id}>
                <div className="cell-stack">
                  <span className="primary">
                    {task.recording_id ? (
                      <Link to={`/app/recordings/${task.recording_id}`}>{task.recording_title}</Link>
                    ) : (
                      task.recording_title
                    )}
                  </span>
                  <span className="secondary">
                    {task.step} · 耗时 {task.elapsed_label}
                    {task.error ? ` · ${task.error}` : ""}
                  </span>
                </div>
                <span className="meta" style={{ marginLeft: "auto", marginRight: "var(--space-4)" }}>
                  {formatRelative(task.finished_at ?? task.updated_at)}
                </span>
                <Status tone={task.status === "done" ? "moss" : "rust"}>
                  {task.status === "done" ? "完成" : "失败"}
                </Status>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
