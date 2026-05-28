import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRoleMapping,
  deleteRoleMapping,
  fetchRoleMappings,
  fetchTeams,
  patchRoleMapping,
} from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { Field, FormRow } from "@/components/Field";
import { readApiError } from "@/api/client";
import type { RoleMapping } from "@/api/types";

const MATCH_TYPES: { value: RoleMapping["match_type"]; label: string }[] = [
  { value: "wecom_userid", label: "企微 userid" },
  { value: "name", label: "姓名" },
  { value: "mobile", label: "手机号" },
  { value: "department_id", label: "企微部门 ID" },
  { value: "team_id", label: "本地团队 ID" },
  { value: "local_username", label: "本地用户名" },
];

const MATCH_LABEL = Object.fromEntries(MATCH_TYPES.map((m) => [m.value, m.label]));

interface DraftMapping {
  match_type: RoleMapping["match_type"];
  match_value: string;
  role: RoleMapping["role"];
  managed_team_ids: string[];
  priority: number;
  active: boolean;
}

const EMPTY_DRAFT: DraftMapping = {
  match_type: "name",
  match_value: "",
  role: "member",
  managed_team_ids: [],
  priority: 100,
  active: true,
};

export function AdminPermissions() {
  const qc = useQueryClient();
  const mappings = useQuery({ queryKey: ["role-mappings"], queryFn: fetchRoleMappings });
  const teams = useQuery({ queryKey: ["teams"], queryFn: fetchTeams });
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState<DraftMapping>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createRoleMapping({
        match_type: draft.match_type,
        match_value: draft.match_value.trim(),
        role: draft.role,
        managed_team_ids: draft.managed_team_ids,
        priority: draft.priority,
        active: draft.active,
      } as Omit<RoleMapping, "id" | "created_at" | "updated_at">),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["role-mappings"] });
      setShowNew(false);
      setDraft(EMPTY_DRAFT);
    },
    onError: (err) => setError(readApiError(err)),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; payload: Partial<RoleMapping> }) =>
      patchRoleMapping(input.id, input.payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-mappings"] }),
    onError: (err) => setError(readApiError(err)),
  });

  const remove = useMutation({
    mutationFn: deleteRoleMapping,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-mappings"] }),
    onError: (err) => setError(readApiError(err)),
  });

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="角色映射"
        subtitle="企微同步进来的成员按匹配条件自动赋予角色。匹配项越靠前优先级越高（priority 越小越优先）。"
        actions={
          <Button variant="primary" size="sm" onClick={() => setShowNew((v) => !v)}>
            {showNew ? "收起" : "新增映射"}
          </Button>
        }
      />

      {error && <Diag code="PERM_E_ACTION">{error}</Diag>}

      {showNew && (
        <div className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-3)" }}>
            <FormRow label="匹配方式">
              <select className="field" value={draft.match_type} onChange={(e) => setDraft({ ...draft, match_type: e.target.value as RoleMapping["match_type"] })}>
                {MATCH_TYPES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </FormRow>
            <FormRow label="匹配值">
              <Field value={draft.match_value} onChange={(e) => setDraft({ ...draft, match_value: e.target.value })} />
            </FormRow>
            <FormRow label="赋予角色">
              <select className="field" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as RoleMapping["role"] })}>
                <option value="member">成员</option>
                <option value="manager">组长</option>
                <option value="admin">管理员</option>
              </select>
            </FormRow>
            <FormRow label="优先级" hint="数字越小越靠前。默认 100。">
              <Field type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
            </FormRow>
          </div>
          {draft.role === "manager" && (
            <FormRow label="管理团队">
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                {(teams.data ?? []).map((t) => (
                  <label key={t.id} style={{ display: "inline-flex", gap: "var(--space-1)", alignItems: "center", padding: "var(--space-1) var(--space-2)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }}>
                    <input
                      type="checkbox"
                      checked={draft.managed_team_ids.includes(t.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          managed_team_ids: e.target.checked
                            ? [...draft.managed_team_ids, t.id]
                            : draft.managed_team_ids.filter((id) => id !== t.id),
                        })
                      }
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            </FormRow>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>取消</Button>
            <Button variant="primary" loading={create.isPending} disabled={!draft.match_value.trim()} onClick={() => create.mutate()}>
              保存映射
            </Button>
          </div>
        </div>
      )}

      {mappings.isError && <Diag code="PERM_E_LIST">{readApiError(mappings.error)}</Diag>}
      {mappings.data && mappings.data.length === 0 && (
        <EmptyState description="还没有自定义映射。默认情况下企微同步进来的人都是成员。" />
      )}
      {mappings.data && mappings.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-fit">优先级</th>
              <th className="col-fit">匹配方式</th>
              <th className="col-grow">匹配值</th>
              <th className="col-fit">角色</th>
              <th className="col-fit">状态</th>
              <th className="col-fit"></th>
            </tr>
          </thead>
          <tbody>
            {mappings.data.map((m) => (
              <tr key={m.id}>
                <td className="meta">{m.priority}</td>
                <td className="cat">{MATCH_LABEL[m.match_type] ?? m.match_type}</td>
                <td><span className="primary">{m.match_value}</span></td>
                <td><Status tone={m.role === "admin" ? "accent" : m.role === "manager" ? "slate" : "muted"}>{m.role === "admin" ? "管理员" : m.role === "manager" ? "组长" : "成员"}</Status></td>
                <td>
                  <Status tone={m.active ? "moss" : "muted"}>{m.active ? "启用" : "停用"}</Status>
                </td>
                <td style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button variant="ghost" size="sm" onClick={() => update.mutate({ id: m.id, payload: { active: !m.active } })}>
                    {m.active ? "停用" : "启用"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`删除映射「${m.match_value} → ${m.role}」？`)) remove.mutate(m.id);
                    }}
                  >
                    删除
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
