import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "@/components/Icon";
import { useAuth } from "@/context/auth";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/utils/cn";
import { Avatar } from "@/components/Avatar";

interface NavItemDef {
  to: string;
  icon: IconName;
  label: string;
  count?: number | string;
  badge?: string;
  end?: boolean;
}

interface NavSectionDef {
  title: string;
  items: NavItemDef[];
}

function memberSections(): NavSectionDef[] {
  return [
    {
      title: "AI 工作台",
      items: [
        { to: "/app/recordings/new", icon: "house", label: "首页" },
        { to: "/app/recordings", icon: "audio-lines", label: "录音库", end: true },
        { to: "/app/tasks", icon: "list-checks", label: "任务进度" },
      ],
    },
    {
      title: "知识与样本",
      items: [
        { to: "/app/hotwords", icon: "spell-check", label: "热词" },
        { to: "/app/voiceprints", icon: "mic", label: "声纹" },
      ],
    },
  ];
}

function adminSections(): NavSectionDef[] {
  return [
    {
      title: "总览",
      items: [{ to: "/admin/overview", icon: "layout-dashboard", label: "总览" }],
    },
    {
      title: "成员与团队",
      items: [
        { to: "/admin/users", icon: "users", label: "用户" },
        { to: "/admin/teams", icon: "building-2", label: "团队" },
        { to: "/admin/permissions", icon: "shield", label: "角色映射" },
        { to: "/admin/wecom", icon: "plug", label: "企业微信" },
      ],
    },
    {
      title: "数据与样本",
      items: [
        { to: "/admin/hotword", icon: "spell-check", label: "热词总览" },
        { to: "/admin/hotword-sources", icon: "database", label: "热词来源" },
        { to: "/admin/voiceprints", icon: "mic", label: "声纹库" },
      ],
    },
    {
      title: "运维与审计",
      items: [
        { to: "/admin/audit", icon: "activity", label: "审计日志" },
        { to: "/admin/asr", icon: "cpu", label: "ASR 配置" },
        { to: "/admin/llm", icon: "brain", label: "大模型" },
        { to: "/admin/storage", icon: "hard-drive", label: "存储" },
        { to: "/admin/storage-queue", icon: "files", label: "队列" },
        { to: "/admin/export", icon: "file-down", label: "导出" },
        { to: "/admin/export-templates", icon: "file-text", label: "导出模板" },
      ],
    },
  ];
}

function buildBreadcrumb(pathname: string): { href?: string; label: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const labelMap: Record<string, string> = {
    app: "工作台",
    admin: "管理控制台",
    recordings: "录音库",
    new: "上传录音",
    tasks: "任务进度",
    hotwords: "热词",
    voiceprints: "声纹",
    overview: "总览",
    users: "用户",
    teams: "团队",
    permissions: "角色映射",
    wecom: "企业微信",
    hotword: "热词总览",
    "hotword-sources": "热词来源",
    audit: "审计日志",
    asr: "ASR 配置",
    llm: "大模型",
    storage: "存储",
    "storage-queue": "队列",
    export: "导出",
    "export-templates": "导出模板",
  };
  // UUID-looking segments are record IDs — replace with a friendly tail label
  // based on the preceding segment (e.g. /recordings/<uuid> → "录音详情").
  const tailFor: Record<string, string> = {
    recordings: "录音详情",
    users: "用户详情",
    teams: "团队详情",
  };
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

  const crumbs: { href?: string; label: string }[] = [];
  let acc = "";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    acc += `/${seg}`;
    const isLast = i === segments.length - 1;
    let label = labelMap[seg] ?? seg;
    if (isUuid(seg)) {
      const parent = segments[i - 1] ?? "";
      label = tailFor[parent] ?? "详情";
    }
    if (i === 0 && segments.length === 1) {
      // Just "/app" — no crumb shown on landing.
      return [];
    }
    crumbs.push({ href: isLast ? undefined : acc, label });
  }
  return crumbs;
}

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const sections = user?.role === "admin" ? adminSections() : memberSections();
  const crumbs = buildBreadcrumb(location.pathname);

  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setAccountOpen(false);
    }
    if (accountOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [accountOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到主内容
      </a>

      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">
          <span className="app-shell__brand-glyph">A</span>
          <span>
            兰之天 <em>AI · 录音转写</em>
          </span>
        </div>
        <nav className="app-shell__sidebar-nav" aria-label="主导航">
          {sections.map((section) => (
            <div className="nav-section" key={section.title}>
              <div className="nav-section__title">{section.title}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn("nav-item", isActive && "is-active")
                  }
                >
                  <Icon name={item.icon} size={16} className="nav-item__icon" />
                  <span className="nav-item__label">{item.label}</span>
                  {item.count != null && (
                    <span className="nav-item__count">{item.count}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="app-shell__account" ref={menuRef}>
          <Avatar name={user?.name} size="md" className="app-shell__account-avatar" />
          <span className="app-shell__account-name">
            {user?.name ?? "—"}
            <span className="app-shell__account-role">
              {user?.role === "admin" ? "管理员" : user?.role === "manager" ? "组长" : "成员"}
              {user?.dept ? ` · ${user.dept}` : ""}
            </span>
          </span>
          <button
            className="app-shell__account-menu"
            aria-label="账号菜单"
            onClick={() => setAccountOpen((v) => !v)}
          >
            <Icon name="ellipsis" size={16} />
          </button>
          {accountOpen && (
            <div
              role="menu"
              className="menu"
              style={{
                position: "absolute",
                bottom: "calc(var(--shell-account-h) + var(--space-2))",
                left: "var(--space-3)",
                right: "var(--space-3)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-lg)",
                padding: "var(--space-1)",
                zIndex: "var(--z-popover)",
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={async () => {
                  setAccountOpen(false);
                  await logout();
                  navigate("/login", { replace: true });
                }}
              >
                <Icon name="log-out" size={14} />
                <span>退出登录</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      <header className="app-shell__topbar">
        <nav className="breadcrumb app-shell__topbar-breadcrumb" aria-label="位置">
          {crumbs.map((crumb, idx) => (
            <span key={`${crumb.label}-${idx}`}>
              {idx > 0 && <span className="breadcrumb__sep">/</span>}
              {crumb.href ? (
                <NavLink to={crumb.href}>{crumb.label}</NavLink>
              ) : (
                <span className="breadcrumb__current">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
        <div className="app-shell__topbar-utils">
          <button type="button" aria-label="搜索">
            <Icon name="search" size={16} />
          </button>
          <button type="button" aria-label="通知">
            <Icon name="bell" size={16} />
          </button>
          <button
            type="button"
            aria-label="主题"
            onClick={() => document.documentElement.classList.toggle("dark")}
          >
            <Icon name="sun" size={16} />
          </button>
        </div>
      </header>

      <main className="app-shell__body" id="main">
        <Outlet />
      </main>
    </div>
  );
}
