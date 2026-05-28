import { useQuery } from "@tanstack/react-query";
import { fetchHotwordStatus } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { PageLoading } from "@/components/PageLoading";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";

export function AdminHotwordSources() {
  const status = useQuery({ queryKey: ["hotwords-status"], queryFn: fetchHotwordStatus });

  if (status.isLoading) return <PageLoading />;
  if (status.isError) {
    return (
      <div className="page-body page--object-index">
        <PageHead title="热词来源" />
        <Diag code="HW_SRC_E">{readApiError(status.error)}</Diag>
      </div>
    );
  }

  const data = status.data!;

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="热词来源"
        subtitle={`总共 ${data.sources.length} 个来源 · 已配额 ASR ${data.limits.asr} / 纠错 ${data.limits.correction} / 保护 ${data.limits.protected}`}
      />

      <section style={{ marginBottom: "var(--space-8)" }}>
        <h2 className="form-section__title">来源构成</h2>
        {data.by_source.length === 0 ? (
          <EmptyState description="还没有任何来源数据。" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th className="col-grow">来源</th>
                <th className="col-fit">总词条</th>
                <th className="col-fit">启用</th>
                <th className="col-fit">受保护</th>
              </tr>
            </thead>
            <tbody>
              {data.by_source.map((row) => (
                <tr key={row.source}>
                  <td><span className="primary">{row.source}</span></td>
                  <td className="meta">{row.total}</td>
                  <td className="meta">{row.active}</td>
                  <td className="meta">{row.protected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: "var(--space-8)" }}>
        <h2 className="form-section__title">已注册来源</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-grow">名称</th>
              <th className="col-fit">类型</th>
              <th className="col-fit">启用</th>
              <th className="col-fit">回看天数</th>
              <th className="col-fit">候选上限</th>
              <th className="col-fit">最近成功</th>
              <th className="col-fit">最近错误</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((src) => (
              <tr key={src.id}>
                <td><span className="primary">{src.name}</span></td>
                <td className="cat">{src.source_type}</td>
                <td>
                  <Status tone={src.enabled ? "moss" : "muted"}>{src.enabled ? "启用" : "停用"}</Status>
                </td>
                <td className="meta">{src.lookback_days}</td>
                <td className="meta">{src.candidate_limit}</td>
                <td className="meta">{formatRelative(src.last_success_at)}</td>
                <td className="meta" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {src.last_error || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="form-section__title">最近同步运行</h2>
        {data.recent_runs.length === 0 ? (
          <EmptyState description="还没有任何同步运行记录。" />
        ) : (
          <table className="data-table row--dense">
            <thead>
              <tr>
                <th className="col-fit">开始时间</th>
                <th className="col-grow">来源</th>
                <th className="col-fit">模式</th>
                <th className="col-fit">状态</th>
                <th className="col-fit">新增</th>
                <th className="col-fit">更新</th>
                <th className="col-fit">重激活</th>
                <th className="col-fit">过期</th>
                <th className="col-fit">跳过</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_runs.map((run) => (
                <tr key={run.id}>
                  <td className="meta" style={{ fontFamily: "var(--font-mono)" }}>{run.started_at}</td>
                  <td>{run.source_name}</td>
                  <td className="cat">{run.mode}</td>
                  <td>
                    <Status tone={run.status === "done" ? "moss" : run.status === "running" ? "accent" : "rust"}>
                      {run.status}
                    </Status>
                  </td>
                  <td className="meta">{run.inserted}</td>
                  <td className="meta">{run.updated}</td>
                  <td className="meta">{run.reactivated}</td>
                  <td className="meta">{run.expired}</td>
                  <td className="meta">{run.skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
