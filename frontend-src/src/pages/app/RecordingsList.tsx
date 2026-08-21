import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchRecordings } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { Diag } from "@/components/Diag";
import { useAuth } from "@/context/auth";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";
import type { Recording, RecordingProcessingStatus } from "@/api/types";

const MEETING_TYPES = ["全部", "内部会议", "客户调研", "方案汇报", "销售电话"];

function statusLabel(status: RecordingProcessingStatus): string {
  switch (status) {
    case "done":
      return "已完成";
    case "running":
      return "进行中";
    case "queued":
      return "排队中";
    case "failed":
      return "失败";
    case "pending":
    default:
      return "未开始";
  }
}

function overallStatus(rec: Recording): { tone: React.ComponentProps<typeof Status>["tone"]; label: string } {
  if (rec.asr_status === "failed" || rec.summary_status === "failed") return { tone: "rust", label: "失败" };
  if (rec.asr_status === "running" || rec.summary_status === "running") return { tone: "accent", label: "进行中" };
  if (rec.asr_status === "queued") return { tone: "slate", label: "排队中" };
  if (rec.asr_status === "done" && rec.summary_status === "done") return { tone: "moss", label: "已完成" };
  if (rec.asr_status === "done") return { tone: "accent", label: "等待纪要" };
  return { tone: "muted", label: "未开始" };
}

export function RecordingsList() {
  const { user } = useAuth();
  const isOrgWide = user?.role === "manager" && (user?.managed_team_ids ?? []).includes("*");
  const [scope, setScope] = useState<"mine" | "team">(isOrgWide ? "team" : "mine");
  const [meetingType, setMeetingType] = useState<string>("全部");
  const [q, setQ] = useState("");

  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["recordings", scope, meetingType, q],
    queryFn: () => fetchRecordings({ scope, meeting_type: meetingType, q }),
  });

  const filtered = query.data ?? [];
  const canSeeTeam = user?.role === "manager";

  const totalLabel = useMemo(() => {
    if (query.isLoading) return "加载中";
    if (filtered.length === 0) return "0 条";
    return `${filtered.length} 条`;
  }, [filtered.length, query.isLoading]);

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="录音库"
        subtitle={`当前 ${totalLabel}。点开任一条进入逐字稿、纪要和说话人视图。`}
        actions={
          <Button variant="primary" onClick={() => navigate("/app/recordings/new")}>
            <Icon name="upload" size={14} /> 上传录音
          </Button>
        }
      />

      <div className="filter-bar">
        <div className="filter-bar__search">
          <Icon name="search" size={14} className="filter-bar__search-icon" />
          <input
            type="search"
            placeholder="搜索标题、客户、标签、负责人"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {canSeeTeam && (
          <div className="filter-bar__segments" role="tablist" aria-label="可见范围">
            <button role="tab" aria-selected={scope === "mine"} onClick={() => setScope("mine")}>
              我的
            </button>
            <button role="tab" aria-selected={scope === "team"} onClick={() => setScope("team")}>
              {isOrgWide ? "全部" : "团队"}
            </button>
          </div>
        )}
        <select
          className="filter-bar__sort"
          value={meetingType}
          onChange={(e) => setMeetingType(e.target.value)}
          aria-label="会议类型"
        >
          {MEETING_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {query.isError && (
        <Diag code="REC_E_LIST">{readApiError(query.error)}</Diag>
      )}

      {!query.isError && query.isLoading && <PageLoading />}

      {!query.isError && !query.isLoading && (filtered.length === 0 ? (
        <EmptyState
          description={
            q || meetingType !== "全部"
              ? "当前筛选下没有匹配的录音。试试清空筛选条件。"
              : "还没有任何录音。从右上角上传一段开始。"
          }
          action={
            !q && meetingType === "全部" ? (
              <Link to="/app/recordings/new">
                <Button variant="ghost">上传录音</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th className="col-grow">录音</th>
                <th className="col-fit">会议类型</th>
                <th className="col-fit">客户 / 项目</th>
                <th className="col-fit">时长</th>
                <th className="col-fit">负责人</th>
                <th className="col-fit">状态</th>
                <th className="col-fit">更新</th>
                <th className="col-fit"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((rec) => {
                const overall = overallStatus(rec);
                return (
                  <tr key={rec.id} onClick={() => navigate(`/app/recordings/${rec.id}`)} className="u-pointer">
                    <td>
                      <div className="cell-stack">
                        <span className="primary">{rec.title}</span>
                        <span className="secondary">{rec.filename}</span>
                      </div>
                    </td>
                    <td className="cat">{rec.meeting_type}</td>
                    <td className="meta">{rec.tag || "—"}</td>
                    <td className="meta">{rec.duration_label}</td>
                    <td className="meta">{rec.owner_name}</td>
                    <td>
                      <Status tone={overall.tone}>{overall.label}</Status>
                      {rec.asr_status === "done" && rec.summary_status === "running" && (
                        <span className="meta u-block u-fs-xs">
                          纪要 {statusLabel(rec.summary_status)}
                        </span>
                      )}
                    </td>
                    <td className="meta">{formatRelative(rec.updated_at)}</td>
                    <td>
                      <button
                        className="icon-btn"
                        aria-label="打开"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/app/recordings/${rec.id}`);
                        }}
                      >
                        <Icon name="external-link" size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="list-footer">
            <span className="count">共 {filtered.length} 条</span>
          </div>
        </>
      ))}
    </div>
  );
}
