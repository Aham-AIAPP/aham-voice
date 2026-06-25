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

      <section className="u-card-grid u-mt-4">
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

      <section className="u-mt-8">
        <h2 className="form-section__title">外部能力</h2>
        <ul className="item-list">
          {data.integrations.map((it) => (
            <li key={it.name} className="u-pad-row-3 u-bb u-flex u-gap-3 u-items-center">
              <div className="u-flex-1">
                <p className="u-fw-500">{it.name}</p>
                <p className="meta u-fs-xs">{it.description}</p>
              </div>
              <Status tone={it.ok ? "moss" : "rust"}>{it.ok ? "可用" : "未就绪"}</Status>
            </li>
          ))}
        </ul>
      </section>

      {sys && (
        <section className="u-mt-8">
          <h2 className="form-section__title">系统</h2>
          <ul className="item-list">
            <li className="u-pad-row-2 u-bb">
              <span className="u-mr-3">数据目录</span>
              <span className="meta u-mono">{sys.base}</span>
            </li>
            <li className="u-pad-row-2 u-bb">
              <span className="u-mr-3">SQLite</span>
              <span className="meta u-mono">{sys.db}</span>
            </li>
            <li className="u-pad-row-2 u-bb">
              <span className="u-mr-3">DeepSeek</span>
              <span className="meta">
                {sys.deepseek_configured ? `已配置 · ${sys.deepseek_model}` : "未配置 API key"}
              </span>
            </li>
            <li className="u-pad-row-2 u-bb">
              <span className="u-mr-3">ASR 模型</span>
              <span className="meta">
                Paraformer {sys.paraformer ? "✓" : "✗"} · VAD {sys.vad ? "✓" : "✗"} · Punc {sys.punc ? "✓" : "✗"} · CAM++ {sys.voiceprint ? "✓" : "✗"} · ffmpeg {sys.ffmpeg ? "✓" : "✗"}
              </span>
            </li>
          </ul>
        </section>
      )}

      <section className="u-mt-8">
        <h2 className="form-section__title">最近审计</h2>
        <ul className="item-list">
          {data.recent_audit.length === 0 && <li className="meta u-pad-row-2">暂无</li>}
          {data.recent_audit.map((row) => (
            <li key={row.id} className="u-pad-row-2 u-bb u-flex u-gap-3">
              <span className="u-mono u-fs-xs u-fg-subtle ov-audit-cat">
                {row.category}
              </span>
              <span className="u-flex-1">{row.message}</span>
              <span className="meta u-fs-xs">
                {row.actor_name} · {formatRelative(row.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
