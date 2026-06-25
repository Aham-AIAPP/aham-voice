import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTeams, fetchUsers, patchUser, resetUserPassword } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Status } from "@/components/Status";
import { Icon } from "@/components/Icon";
import { Diag } from "@/components/Diag";
import { EmptyState } from "@/components/EmptyState";
import { Field, FormRow } from "@/components/Field";
import { Avatar } from "@/components/Avatar";
import { readApiError } from "@/api/client";
import { useAuth } from "@/context/auth";
import { formatRelative } from "@/utils/format";
import type { Role, User } from "@/api/types";

const ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  manager: "组长",
  member: "成员",
};

const ROLE_TONE: Record<Role, React.ComponentProps<typeof Status>["tone"]> = {
  admin: "accent",
  manager: "slate",
  member: "muted",
};

function UserEditor({ user, teams, onClose }: { user: User; teams: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { user: actor } = useAuth();
  const [draft, setDraft] = useState({
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    dept: user.dept,
    role: user.role,
    team_id: user.team_id ?? "",
    managed_team_ids: user.managed_team_ids,
    status: user.status,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const isSelf = user.id === actor?.id;

  const save = useMutation({
    mutationFn: () =>
      patchUser(user.id, {
        name: draft.name.trim(),
        email: draft.email.trim(),
        mobile: draft.mobile.trim(),
        dept: draft.dept.trim(),
        role: draft.role,
        team_id: draft.team_id || null,
        managed_team_ids: draft.managed_team_ids,
        status: draft.status,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err) => setError(readApiError(err)),
  });

  const resetPwd = useMutation({
    mutationFn: () => resetUserPassword(user.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: (err) => setError(readApiError(err)),
  });

  return (
    <div className="card u-p-5 u-flex u-col u-gap-4 usr-editor-card">
      <header className="u-flex u-gap-3 u-items-center">
        <Avatar name={user.name} size="md" />
        <div className="u-flex-1">
          <strong>{user.name}</strong>
          <p className="meta u-fs-xs">
            {user.username} · {user.source === "wecom" ? "企业微信" : "本地账号"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </header>

      {error && <Diag code="USER_E_PATCH">{error}</Diag>}

      <div className="u-card-grid">
        <FormRow label="姓名">
          <Field value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </FormRow>
        <FormRow label="邮箱">
          <Field type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        </FormRow>
        <FormRow label="手机">
          <Field value={draft.mobile} onChange={(e) => setDraft({ ...draft, mobile: e.target.value })} />
        </FormRow>
        <FormRow label="部门">
          <Field value={draft.dept} onChange={(e) => setDraft({ ...draft, dept: e.target.value })} />
        </FormRow>
        <FormRow label="角色" hint={isSelf ? "不能修改自己的角色。" : undefined}>
          <select
            className="field"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
            disabled={isSelf}
          >
            <option value="member">成员</option>
            <option value="manager">组长</option>
            <option value="admin">管理员</option>
          </select>
        </FormRow>
        <FormRow label="所属团队">
          <select
            className="field"
            value={draft.team_id}
            onChange={(e) => setDraft({ ...draft, team_id: e.target.value })}
          >
            <option value="">无</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </FormRow>
        <FormRow label="状态" hint={isSelf ? "不能停用自己。" : undefined}>
          <select
            className="field"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as "active" | "disabled" })}
            disabled={isSelf}
          >
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </FormRow>
      </div>

      {draft.role === "manager" && (
        <FormRow label="管理团队" hint="勾选 manager 能查看 / 管理的团队。">
          <div className="u-cluster-wrap">
            {teams.map((t) => (
              <label key={t.id} className="u-iflex u-gap-1 u-items-center u-pad-1-2 usr-team-chip">
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

      <div className="u-flex u-between u-gap-2">
        <Button
          variant="ghost"
          loading={resetPwd.isPending}
          onClick={() => {
            setConfirmReset(true);
          }}
        >
          重置密码
        </Button>
        <div className="u-row">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存</Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmReset}
        tone="danger"
        title="重置密码"
        body={`将 ${user.name} 的密码重置为默认值，并强制其下次登录修改？`}
        confirmText="重置"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => { setConfirmReset(false); resetPwd.mutate(); }}
      />
    </div>
  );
}

export function AdminUsers() {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["users", q, role, status],
    queryFn: () => fetchUsers({ q, role, status }),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: fetchTeams });

  const editing = users.data?.find((u) => u.id === editingId) ?? null;

  return (
    <div className="page-body page--object-index">
      <PageHead
        title="用户"
        subtitle={users.data ? `共 ${users.data.length} 个用户` : "加载中…"}
      />

      <div className="filter-bar">
        <div className="filter-bar__search">
          <Icon name="search" size={14} className="filter-bar__search-icon" />
          <input
            type="search"
            placeholder="搜索姓名、用户名、邮箱、手机、部门、企微 ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="filter-bar__sort" value={role} onChange={(e) => setRole(e.target.value)} aria-label="角色">
          <option value="">全部角色</option>
          <option value="admin">管理员</option>
          <option value="manager">组长</option>
          <option value="member">成员</option>
        </select>
        <select className="filter-bar__sort" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状态">
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </div>

      {users.isError && <Diag code="USER_E_LIST">{readApiError(users.error)}</Diag>}
      {users.data && users.data.length === 0 && <EmptyState description="没有匹配的用户。" />}

      {editing && (
        <UserEditor
          user={editing}
          teams={teams.data ?? []}
          onClose={() => setEditingId(null)}
        />
      )}

      {users.data && users.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-grow">姓名</th>
              <th className="col-fit">用户名</th>
              <th className="col-fit">部门</th>
              <th className="col-fit">角色</th>
              <th className="col-fit">来源</th>
              <th className="col-fit">状态</th>
              <th className="col-fit">最近活跃</th>
              <th className="col-fit"></th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="cell-row">
                    <Avatar name={u.name} size="md" />
                    <div className="cell-stack">
                      <span className="primary">{u.name}</span>
                      <span className="secondary">{u.email || "—"}</span>
                    </div>
                  </div>
                </td>
                <td className="meta u-mono">{u.username}</td>
                <td className="cat">{u.dept || "—"}</td>
                <td><Status tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Status></td>
                <td className="meta">{u.source === "wecom" ? "企微" : "本地"}</td>
                <td>
                  <Status tone={u.status === "active" ? "moss" : "muted"}>
                    {u.status === "active" ? "启用" : "停用"}
                  </Status>
                </td>
                <td className="meta">{formatRelative(u.last_active_at)}</td>
                <td>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(u.id)}>编辑</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
