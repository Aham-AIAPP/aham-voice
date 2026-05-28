import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchVoiceprints, patchVoiceprint } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { readApiError } from "@/api/client";
import { formatRelative } from "@/utils/format";

const SCOPE_LABEL: Record<string, string> = {
  personal: "仅我",
  team: "团队共享",
  global: "全公司",
};

export function AdminVoiceprints() {
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ["voiceprints"], queryFn: fetchVoiceprints });
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof patchVoiceprint>[1] }) =>
      patchVoiceprint(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voiceprints"] }),
  });

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="声纹库"
        subtitle={rows.data ? `共 ${rows.data.length} 个声纹（全公司视角，按 scope 排序）` : "加载中…"}
      />

      {rows.isError && <Diag code="VP_E_LIST">{readApiError(rows.error)}</Diag>}
      {rows.data && rows.data.length === 0 && (
        <EmptyState description="还没有声纹。可让团队从录音详情里保存，或在用户端的「声纹」页上传。" />
      )}

      {rows.data && rows.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-grow">说话人</th>
              <th className="col-fit">可见范围</th>
              <th className="col-fit">阈值</th>
              <th className="col-fit">归属团队</th>
              <th className="col-fit">状态</th>
              <th className="col-fit">创建</th>
              <th className="col-fit"></th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((vp) => (
              <tr key={vp.id}>
                <td><span className="primary">{vp.name}</span></td>
                <td className="cat">{SCOPE_LABEL[vp.scope] ?? vp.scope}</td>
                <td className="meta" style={{ fontFamily: "var(--font-mono)" }}>{Number(vp.threshold).toFixed(2)}</td>
                <td className="meta">{vp.team_id ?? "—"}</td>
                <td>
                  <Status tone={vp.active ? "moss" : "muted"}>{vp.active ? "启用" : "停用"}</Status>
                </td>
                <td className="meta">{formatRelative(vp.created_at)}</td>
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => update.mutate({ id: vp.id, payload: { active: vp.active ? 0 : 1 } })}
                  >
                    {vp.active ? "停用" : "启用"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
