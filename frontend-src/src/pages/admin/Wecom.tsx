import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWecomConfig, patchWecomConfig, syncWecom } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { Field, FormRow } from "@/components/Field";
import { Status } from "@/components/Status";
import { readApiError } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { WecomSyncResult } from "@/api/types";

export function AdminWecom() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["wecom-config"], queryFn: fetchWecomConfig });

  const [corpId, setCorpId] = useState("");
  const [salesDept, setSalesDept] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WecomSyncResult | null>(null);
  const [synced, setSynced] = useState<WecomSyncResult | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);

  useEffect(() => {
    if (config.data) {
      setCorpId(config.data.corp_id ?? "");
      setSalesDept(config.data.sales_department_id ?? "");
    }
  }, [config.data]);

  const save = useMutation({
    mutationFn: () =>
      patchWecomConfig({
        corp_id: corpId.trim(),
        sales_department_id: salesDept.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wecom-config"] });
      setSecret("");
    },
    onError: (err) => setError(readApiError(err)),
  });

  const previewSync = useMutation({
    mutationFn: () => syncWecom(true),
    onSuccess: (data) => setPreview(data),
    onError: (err) => setError(readApiError(err)),
  });

  const realSync = useMutation({
    mutationFn: () => syncWecom(false),
    onSuccess: (data) => {
      setSynced(data);
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (err) => setError(readApiError(err)),
  });

  return (
    <div className="page-body page--object-index wc-page">
      <PageHead
        title="企业微信"
        subtitle="配置 CorpID / Secret / 销售部门 ID 后，预演看看会同步哪些人，确认后再正式写入。"
      />

      {error && <Diag code="WECOM_E_ACTION">{error}</Diag>}

      <section className="card u-p-5 u-mb-4 u-flex u-col u-gap-4">
        <FormRow label="CorpID" required>
          <Field value={corpId} onChange={(e) => setCorpId(e.target.value)} placeholder="如：ww1234567890abcdef" />
        </FormRow>
        <FormRow
          label="Secret"
          required
          hint={config.data?.secret_configured ? "已配置 secret，留空表示不更新。" : "首次配置必须填。"}
        >
          <Field
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={config.data?.secret_configured ? "•••••••• （留空保持现状）" : "应用 Secret"}
            autoComplete="new-password"
          />
        </FormRow>
        <FormRow label="销售部门 ID" required hint="顶层销售部门的企微 department id，子部门会一起拉取。">
          <Field value={salesDept} onChange={(e) => setSalesDept(e.target.value)} placeholder="如：12" />
        </FormRow>
        <div className="u-row-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存配置</Button>
        </div>
      </section>

      <section className="u-flex u-gap-2 u-mb-4">
        <Button variant="ghost" loading={previewSync.isPending} onClick={() => { setError(null); setPreview(null); previewSync.mutate(); }}>
          预演同步
        </Button>
        <Button
          variant="primary"
          loading={realSync.isPending}
          onClick={() => {
            setConfirmSync(true);
          }}
        >
          正式同步
        </Button>
      </section>

      {preview && <SyncResultCard title="预演结果" result={preview} />}
      {synced && <SyncResultCard title="正式同步完成" result={synced} />}

      <ConfirmDialog
        open={confirmSync}
        tone="danger"
        title="正式同步企业微信成员"
        body="正式从企业微信同步成员？被删除的成员会被本地停用。"
        confirmText="正式同步"
        onCancel={() => setConfirmSync(false)}
        onConfirm={() => { setConfirmSync(false); setError(null); setSynced(null); realSync.mutate(); }}
      />
    </div>
  );
}

function SyncResultCard({ title, result }: { title: string; result: WecomSyncResult }) {
  if (!result.team_count && result.added.length + result.updated.length + result.disabled.length === 0) {
    return <EmptyState description={`${title}：没有变化。`} />;
  }
  return (
    <section className="card u-p-5 u-mb-4 u-flex u-col u-gap-3">
      <header className="u-flex u-gap-2 u-items-center">
        <strong>{title}</strong>
        <Status tone="moss">新增 {result.added_count}</Status>
        <Status tone="accent">更新 {result.updated_count}</Status>
        <Status tone="amber">停用 {result.disabled_count}</Status>
        {result.initial_password && (
          <span className="meta u-ml-auto u-mono">
            初始密码 {result.initial_password}
          </span>
        )}
      </header>
      {result.added.length > 0 && <p className="meta">新增：{result.added.join("、")}</p>}
      {result.updated.length > 0 && <p className="meta">更新：{result.updated.join("、")}</p>}
      {result.disabled.length > 0 && <p className="meta">停用：{result.disabled.join("、")}</p>}
    </section>
  );
}
