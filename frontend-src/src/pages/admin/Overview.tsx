import { useQuery } from "@tanstack/react-query";
import { fetchAdminOverview, fetchSystemStatus } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { PageLoading } from "@/components/PageLoading";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";

export function AdminOverview() {
  const overview = useQuery({ queryKey: ["admin-overview"], queryFn: fetchAdminOverview });
  const system = useQuery({ queryKey: ["system-status"], queryFn: fetchSystemStatus });

  if (overview.isLoading || system.isLoading) return <PageLoading />;
  if (overview.isError) return (
    <div className="page-body page--landing">
      <PageHead title="管理控制台" />
      <Diag code="ADMIN_E_OVERVIEW">{readApiError(overview.error)}</Diag>
    </div>
  );

  const data = overview.data!;
  const sys = system.data;

  return (
    <div className="page-body page--landing">
      <PageHead
        title="管理控制台"
        subtitle={`${data.active_users} 名启用用户 · ${data.team_count} 个团队 · 今日处理 ${data.today_processed_label} 录音 · 占用 ${data.storage_label}`}
      />

      <section style={{ marginTop: "var(--space-4)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-4)" }}>
        <article className="metric">
          <span className="metric__label">启用用户</span>
          <span className="metric__value">{data.active_users}</span>
        </article>
        <article className="metric">
          <span className="metric__label">团队</span>
          <span className="metric__value">{data.team_count}</span>
        </article>
        <article className="metric">
          <span className="metric__label">今日处理</span>
          <span className="metric__value">{data.today_processed_label}</span>
          <span className="metric__delta">已完成</span>
        </article>
        <article className="metric">
          <span className="metric__label">本地存储</span>
          <span className="metric__value">{data.storage_label}</span>
        </article>
      </section>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="form-section__title">外部能力</h2>
        <ul className="item-list">
          {data.integrations.map((it) => (
            <li key={it.name} style={{ padding: "var(--space-3) 0", borderBottom: "1px solid var(--border-default)", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 500 }}>{it.name}</p>
                <p className="meta" style={{ fontSize: "var(--text-xs)" }}>{it.description}</p>
              </div>
              <Status tone={it.ok ? "moss" : "rust"}>{it.ok ? "可用" : "未就绪"}</Status>
            </li>
          ))}
        </ul>
      </section>

      {sys && (
        <section style={{ marginTop: "var(--space-8)" }}>
          <h2 className="form-section__title">系统</h2>
          <ul className="item-list">
            <li style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)" }}>
              <span style={{ marginRight: "var(--space-3)" }}>数据目录</span>
              <span className="meta" style={{ fontFamily: "var(--font-mono)" }}>{sys.base}</span>
            </li>
            <li style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)" }}>
              <span style={{ marginRight: "var(--space-3)" }}>SQLite</span>
              <span className="meta" style={{ fontFamily: "var(--font-mono)" }}>{sys.db}</span>
            </li>
            <li style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)" }}>
              <span style={{ marginRight: "var(--space-3)" }}>DeepSeek</span>
              <span className="meta">
                {sys.deepseek_configured ? `已配置 · ${sys.deepseek_model}` : "未配置 API key"}
              </span>
            </li>
            <li style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)" }}>
              <span style={{ marginRight: "var(--space-3)" }}>ASR 模型</span>
              <span className="meta">
                Paraformer {sys.paraformer ? "✓" : "✗"} · VAD {sys.vad ? "✓" : "✗"} · Punc {sys.punc ? "✓" : "✗"} · CAM++ {sys.voiceprint ? "✓" : "✗"} · ffmpeg {sys.ffmpeg ? "✓" : "✗"}
              </span>
            </li>
          </ul>
        </section>
      )}

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="form-section__title">最近审计</h2>
        <ul className="item-list">
          {data.recent_audit.length === 0 && <li className="meta" style={{ padding: "var(--space-2) 0" }}>暂无</li>}
          {data.recent_audit.map((row) => (
            <li key={row.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-default)", display: "flex", gap: "var(--space-3)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-subtle)", minWidth: 120 }}>
                {row.category}
              </span>
              <span style={{ flex: 1 }}>{row.message}</span>
              <span className="meta" style={{ fontSize: "var(--text-xs)" }}>
                {row.actor_name} · {formatRelative(row.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
