import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditCsvUrl, fetchAuditRows } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { readApiError } from "@/api/client";

const CATEGORIES = [
  { value: "", label: "全部类别" },
  { value: "auth", label: "鉴权" },
  { value: "user", label: "用户" },
  { value: "team", label: "团队" },
  { value: "wecom", label: "企业微信" },
  { value: "recording", label: "录音" },
  { value: "summary", label: "纪要" },
  { value: "hotword", label: "热词" },
  { value: "voiceprint", label: "声纹" },
  { value: "system", label: "系统" },
];

export function AdminAudit() {
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const rows = useQuery({
    queryKey: ["audit", category, q, from, to],
    queryFn: () => fetchAuditRows({ category, q, from, to }),
  });

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="审计日志"
        subtitle={rows.data ? `最近 ${rows.data.length} 条（按时间倒序，最多 200）` : "加载中…"}
        actions={
          <a href={auditCsvUrl({ category, q, from, to })} className="btn btn--ghost btn--sm" download>
            <Icon name="download" size={14} /> 导出 CSV
          </a>
        }
      />

      <div className="filter-bar">
        <div className="filter-bar__search">
          <Icon name="search" size={14} className="filter-bar__search-icon" />
          <input
            type="search"
            placeholder="搜索消息或操作人"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="filter-bar__sort" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="类别">
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <Field type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起始日期" />
        <Field type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="截止日期" />
        <Button variant="ghost" size="sm" onClick={() => { setQ(""); setCategory(""); setFrom(""); setTo(""); }}>
          清空筛选
        </Button>
      </div>

      {rows.isError && <Diag code="AUDIT_E_LIST">{readApiError(rows.error)}</Diag>}
      {rows.data && rows.data.length === 0 && <EmptyState description="当前筛选下没有审计记录。" />}

      {rows.data && rows.data.length > 0 && (
        <table className="data-table row--dense">
          <thead>
            <tr>
              <th className="col-fit">时间</th>
              <th className="col-fit">类别</th>
              <th className="col-fit">操作人</th>
              <th className="col-grow">内容</th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((row) => (
              <tr key={row.id}>
                <td className="meta u-mono">{row.created_at}</td>
                <td className="cat">{row.category}</td>
                <td className="meta">{row.actor_name}</td>
                <td>{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
