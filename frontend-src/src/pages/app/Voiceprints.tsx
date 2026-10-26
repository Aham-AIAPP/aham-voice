import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteVoiceprint, fetchVoiceprints, patchVoiceprint } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VoiceprintEditModal } from "@/components/VoiceprintEditModal";
import { readApiError } from "@/api/client";
import { useAuth } from "@/context/auth";
import { formatRelative } from "@/utils/format";
import type { User, Voiceprint } from "@/api/types";

const SCOPE_LABEL: Record<string, string> = { personal: "仅我", team: "团队共享", global: "全公司" };

// 与后端 can_manage_voiceprint 对齐：决定哪些行可编辑/删除，避免点了拿 403。
function canManage(vp: Voiceprint, user: User | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "manager") {
    return vp.owner_id === user.id || (!!vp.team_id && (user.managed_team_ids ?? []).includes(vp.team_id));
  }
  return vp.scope === "personal" && vp.owner_id === user.id;
}

// 声纹库（对齐 aham-voice 开源版）：列出已建立的声纹（由录音详情页的命名流程创建），
// 支持改姓名 + 备注、删除。上传样本 / 阈值滑块等已移到 admin 团队版与录音详情页。
export function Voiceprints() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const voiceprints = useQuery({ queryKey: ["voiceprints"], queryFn: fetchVoiceprints });

  const [editing, setEditing] = useState<Voiceprint | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Voiceprint | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { name: string; note: string } }) =>
      patchVoiceprint(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["voiceprints"] });
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => setEditError(readApiError(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteVoiceprint(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voiceprints"] }),
    onError: (err) => setDeleteError(readApiError(err)),
  });

  const rows = voiceprints.data ?? [];

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="声纹"
        subtitle={`共 ${rows.length} 个声纹。新录音会自动用这些声纹标注说话人。`}
      />

      {deleteError && <Diag code="VP_E_DELETE">{deleteError}</Diag>}
      {voiceprints.isError && (
        <Diag
          code="VP_E_LIST"
          actions={
            <Button variant="secondary" size="sm" onClick={() => voiceprints.refetch()}>重试</Button>
          }
        >
          {readApiError(voiceprints.error)}
        </Diag>
      )}

      {rows.length === 0 && !voiceprints.isLoading && !voiceprints.isError && (
        <EmptyState
          description="还没有声纹。声纹用来在新录音里自动标注说话人——先上传一段录音，在详情页点说话人、填写姓名即可建立。"
          action={
            <Link to="/app/recordings/new">
              <Button variant="primary" size="sm"><Icon name="plus" size={14} /> 去上传录音</Button>
            </Link>
          }
        />
      )}

      {rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>备注</th>
              <th>可见范围</th>
              <th>创建时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((vp) => (
              <tr key={vp.id}>
                <td>{vp.name}</td>
                <td className="cat">{vp.note ? vp.note : "—"}</td>
                <td className="cat">{SCOPE_LABEL[vp.scope] ?? vp.scope}</td>
                <td className="cat">{formatRelative(vp.created_at)}</td>
                <td className="row-actions u-text-right u-nowrap">
                  {canManage(vp, user) ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditError(null); setEditing(vp); }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => { setDeleteError(null); setPendingDelete(vp); }}
                      >
                        删除
                      </Button>
                    </>
                  ) : (
                    <span className="meta u-fs-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <VoiceprintEditModal
        open={!!editing}
        initialName={editing?.name ?? ""}
        initialNote={editing?.note ?? ""}
        saving={update.isPending}
        error={editError}
        onClose={() => { if (!update.isPending) { setEditing(null); setEditError(null); } }}
        onSave={(value) => {
          if (!editing) return;
          setEditError(null);
          update.mutate({ id: editing.id, payload: value });
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        tone="danger"
        title="删除声纹"
        body={pendingDelete ? `删除「${pendingDelete.name}」？该操作不可撤销。` : ""}
        confirmText="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          setDeleteError(null);
          remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
