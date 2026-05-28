import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTeams, fetchUsers, patchTeam } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { Field, FormRow } from "@/components/Field";
import { readApiError } from "@/api/client";
import type { Team } from "@/api/types";

function TeamEditor({ team, onClose }: { team: Team; onClose: () => void }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users-all"], queryFn: () => fetchUsers({}) });
  const [name, setName] = useState(team.name);
  const [dept, setDept] = useState(team.dept);
  const [managerIds, setManagerIds] = useState<string[]>(team.manager_ids);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      patchTeam(team.id, { name: name.trim(), dept: dept.trim(), manager_ids: managerIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      onClose();
    },
    onError: (err) => setError(readApiError(err)),
  });

  const managers = (users.data ?? []).filter((u) => u.role === "manager" || u.role === "admin");

  return (
    <div className="card" style={{ padding: "var(--space-5)", margin: "var(--space-3) 0", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{team.name}</strong>
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </header>
      {error && <Diag code="TEAM_E_PATCH">{error}</Diag>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-4)" }}>
        <FormRow label="名称">
          <Field value={name} onChange={(e) => setName(e.target.value)} />
        </FormRow>
        <FormRow label="所属部门">
          <Field value={dept} onChange={(e) => setDept(e.target.value)} />
        </FormRow>
      </div>
      <FormRow label="主管 / 组长" hint="勾选可以管理本团队成员的人。">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {managers.length === 0 && <span className="meta">没有 manager / admin 用户。</span>}
          {managers.map((u) => (
            <label key={u.id} style={{ display: "inline-flex", gap: "var(--space-1)", alignItems: "center", padding: "var(--space-1) var(--space-2)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }}>
              <input
                type="checkbox"
                checked={managerIds.includes(u.id)}
                onChange={(e) =>
                  setManagerIds((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)))
                }
              />
              <span>{u.name}</span>
            </label>
          ))}
        </div>
      </FormRow>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存</Button>
      </div>
    </div>
  );
}

export function AdminTeams() {
  const teams = useQuery({ queryKey: ["teams"], queryFn: fetchTeams });
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = teams.data?.find((t) => t.id === editingId) ?? null;

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="团队"
        subtitle={teams.data ? `共 ${teams.data.length} 个团队` : "加载中…"}
      />

      {teams.isError && <Diag code="TEAM_E_LIST">{readApiError(teams.error)}</Diag>}
      {teams.data && teams.data.length === 0 && (
        <EmptyState description="还没有团队。同步企业微信可一次性创建对应团队。" />
      )}

      {editing && <TeamEditor team={editing} onClose={() => setEditingId(null)} />}

      {teams.data && teams.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-grow">团队</th>
              <th className="col-fit">部门</th>
              <th className="col-fit">企微部门 ID</th>
              <th className="col-fit">成员</th>
              <th className="col-fit">录音</th>
              <th className="col-fit"></th>
            </tr>
          </thead>
          <tbody>
            {teams.data.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className="primary">{t.name}</span>
                </td>
                <td className="cat">{t.dept || "—"}</td>
                <td className="meta" style={{ fontFamily: "var(--font-mono)" }}>{t.wecom_department_id ?? "—"}</td>
                <td className="meta">{t.member_count}</td>
                <td className="meta">{t.recording_count}</td>
                <td>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(t.id)}>编辑</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
