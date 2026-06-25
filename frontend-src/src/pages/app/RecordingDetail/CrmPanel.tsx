import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { searchCrmOpportunities, syncRecordingToCrm } from "@/api/endpoints";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { Status } from "@/components/Status";
import { EmptyState } from "@/components/EmptyState";
import { Field, FormRow } from "@/components/Field";
import { readApiError } from "@/api/client";
import type { CrmSync } from "@/api/types";
import { formatRelative } from "@/utils/format";

interface Props {
  recordingId: string;
  crm: CrmSync;
  summaryStatus: string;
}

function statusTone(status: string): React.ComponentProps<typeof Status>["tone"] {
  switch (status) {
    case "synced":
      return "moss";
    case "syncing":
      return "accent";
    case "failed":
      return "rust";
    case "not_configured":
      return "amber";
    default:
      return "muted";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "synced":
      return "已同步到 Orchisky CRM";
    case "syncing":
      return "同步中";
    case "failed":
      return "上次失败";
    case "not_configured":
      return "未配置";
    default:
      return "未同步";
  }
}

export function CrmPanel({ recordingId, crm, summaryStatus }: Props) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const search = useQuery({
    queryKey: ["crm-search", query],
    queryFn: () => searchCrmOpportunities(query.trim()),
    enabled: query.trim().length > 0,
  });

  const sync = useMutation({
    mutationFn: (relation?: { targetType?: string; targetId: string; targetName?: string; confidence?: number }) =>
      syncRecordingToCrm(recordingId, relation),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recording", recordingId] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  if (summaryStatus !== "done") {
    return <EmptyState description="生成完纪要后才能同步到 Orchisky CRM。" />;
  }

  return (
    <div className="u-stack-6">
      <div className="u-flex u-items-center u-gap-3 u-wrap">
        <Status tone={statusTone(crm.status)}>{statusLabel(crm.status)}</Status>
        {crm.synced_at && <span className="meta u-fs-xs">{formatRelative(crm.synced_at)}</span>}
        {crm.relation_target_name && (
          <span className="meta u-fs-xs">
            关联：{crm.relation_target_name}
            {crm.relation_source ? `（${crm.relation_source}）` : ""}
          </span>
        )}
        <div className="u-ml-auto u-flex u-gap-2">
          {crm.recording_url && (
            <a className="btn btn--ghost btn--sm" href={crm.recording_url} target="_blank" rel="noopener">
              打开录音页
            </a>
          )}
          {crm.minute_url && (
            <a className="btn btn--ghost btn--sm" href={crm.minute_url} target="_blank" rel="noopener">
              打开纪要
            </a>
          )}
          {crm.emotion_url && (
            <a className="btn btn--ghost btn--sm" href={crm.emotion_url} target="_blank" rel="noopener">
              打开情绪分析
            </a>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={sync.isPending}
            disabled={crm.status === "syncing" || crm.status === "not_configured"}
            onClick={() => {
              setError(null);
              sync.mutate(undefined);
            }}
          >
            {crm.status === "synced" ? "重新同步" : "立即同步"}
          </Button>
        </div>
      </div>

      {crm.error && <Diag code="CRM_E_SYNC">{crm.error}</Diag>}
      {error && <Diag code="CRM_E_REQUEST">{error}</Diag>}

      <section className="card u-p-5">
        <header className="u-mb-3">
          <h3 className="u-fs-lg u-fw-600">手动关联到具体商机</h3>
          <p className="meta u-fs-xs">
            搜索 Orchisky CRM 商机（按名称、客户、负责人或单据号），点中后会触发一次新的同步并把关联标记为人工确认。
          </p>
        </header>
        <FormRow label="搜索商机" optional htmlFor="crm-search">
          <Field
            id="crm-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="如：南都电源 储能"
          />
        </FormRow>

        {search.isError && <Diag code="CRM_E_SEARCH">{readApiError(search.error)}</Diag>}
        {search.data && search.data.candidates.length === 0 && query.trim() && (
          <EmptyState description="没有匹配的商机。试试缩短关键词或换个写法。" />
        )}

        {search.data && search.data.candidates.length > 0 && (
          <ul className="item-list u-mt-3">
            {search.data.candidates.map((cand) => (
              <li key={cand.targetId} className="u-pad-row-3 u-flex u-gap-3 u-items-start u-bb">
                <div className="u-flex-1">
                  <p className="u-fw-500">{cand.targetName}</p>
                  <p className="meta u-fs-xs">
                    {[cand.customerName, cand.responsibleName, cand.stage, cand.industry]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {cand.requirementPreview && (
                    <p className="secondary u-fs-xs u-mt-1">
                      {cand.requirementPreview}
                    </p>
                  )}
                </div>
                <span className="meta u-fs-xs">
                  匹配度 {Math.round(cand.confidence * 100)}%
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={sync.isPending}
                  onClick={() => {
                    setError(null);
                    sync.mutate({
                      targetType: cand.targetType,
                      targetId: cand.targetId,
                      targetName: cand.targetName,
                      confidence: cand.confidence,
                    });
                  }}
                >
                  关联并同步
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
