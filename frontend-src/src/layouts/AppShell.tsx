import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "@/components/Icon";
import { useAuth } from "@/context/auth";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/utils/cn";
import { useFocusTrap } from "@/hooks/useFocusTrap";
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
        { to: "/app/recordings/new", icon: "plus", label: "新增" },
        { to: "/app/recordings", icon: "audio-lines", label: "录音库", end: true },
        { to: "/app/integrations", icon: "plug", label: "钉钉同步与 MCP" },
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
        { to: "/admin/hotword", icon: "spell-check", label: "热词" },
        { to: "/admin/voiceprints", icon: "mic", label: "声纹库" },
      ],
    },
    {
      title: "运维与审计",
      items: [
        { to: "/admin/audit", icon: "activity", label: "审计日志" },
        { to: "/admin/llm", icon: "sliders-horizontal", label: "系统配置" },
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
    hotwords: "热词",
    voiceprints: "声纹",
    integrations: "钉钉同步与 MCP",
    overview: "总览",
    users: "用户",
    teams: "团队",
    permissions: "角色映射",
    wecom: "企业微信",
    hotword: "热词",
    audit: "审计日志",
    llm: "系统配置",
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
    if (isUuid(seg) || (segments[i - 1] === "recordings" && seg !== "new")) {
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
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("voice.sidebar") === "collapsed"; } catch { return false; } });
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
  const sidebarRef = useFocusTrap<HTMLElement>(narrow && mobileOpen);
  const shortcutsRef = useRef<HTMLDialogElement>(null);
  const paletteRef = useRef<HTMLDialogElement>(null);
  const [commands, setCommands] = useState<Array<{ label: string; run: () => void }>>([]);
  const [commandQuery, setCommandQuery] = useState("");
  function toggleSidebar() {
    if (narrow) setMobileOpen(value => !value);
    else setCollapsed(value => !value);
  }
  function toggleTheme() { setTheme(value => value === "dark" ? "light" : "dark"); }
  function openPalette() {
    const pageCommands = Array.from(document.querySelectorAll<HTMLElement>("#main button, #main a[href], #main summary"))
      .filter(el => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true")
      .map(el => ({ label: el.getAttribute("aria-label") || el.textContent?.trim() || "", run: () => {
        let parent = el.parentElement;
        while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
        el.scrollIntoView({ block: "nearest" }); el.focus(); el.click();
      } })).filter(command => command.label);
    setCommands([
      ...sections.flatMap(section => section.items.map(item => ({ label: "前往 " + item.label, run: () => navigate(item.to) }))),
      { label: "键盘快捷键", run: () => shortcutsRef.current?.showModal() },
      { label: "切换深色 / 浅色主题", run: toggleTheme },
      { label: "展开 / 收起导航", run: toggleSidebar },
      ...pageCommands,
    ].filter((command, index, all) => all.findIndex(other => other.label === command.label) === index));
    setCommandQuery("");
    paletteRef.current?.showModal();
  }
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    const update = () => { setNarrow(media.matches); setMobileOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("voice.theme", theme); } catch { /* Storage may be unavailable. */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem("voice.sidebar", collapsed ? "collapsed" : "expanded"); } catch { /* Storage may be unavailable. */ }
  }, [collapsed]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); }
      const target = event.target as HTMLElement;
      const editing = target.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === "?" && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); shortcutsRef.current?.showModal();
      }
      if (event.key === "Escape") { setAccountOpen(false); setMobileOpen(false); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setAccountOpen(false);
    }
    if (accountOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [accountOpen]);

  return (
    <div className={cn("app-shell", collapsed && "is-collapsed", mobileOpen && "is-nav-open")}>
      <a className="skip-link" href="#main">
        跳到主内容
      </a>

      {narrow && mobileOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
      <aside className="app-shell__sidebar" ref={sidebarRef} aria-label="导航侧栏">
        <div className="app-shell__brand">
          <button className="icon-btn sidebar-toggle" aria-label={narrow ? "关闭导航" : "收起导航"} title="展开 / 收起导航（⌘/Ctrl+B）" onClick={toggleSidebar}><Icon name="panel-left" size={14} /></button>
          <span className="app-shell__brand-name">
            Orchisky <em>Voice</em>
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
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => setMobileOpen(false)}
                  end={item.end}
                  className={({ isActive }) =>
                    cn("nav-item", isActive && "is-active")
                  }
                >
                  <Icon name={item.icon} size={14} className="nav-item__icon" />
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
            aria-expanded={accountOpen}
            aria-haspopup="true"
            onClick={() => setAccountOpen((v) => !v)}
          >
            <Icon name="ellipsis" size={16} />
          </button>
          {accountOpen && (
            <div
              onKeyDown={e => { if (e.key === "Escape") { setAccountOpen(false); menuRef.current?.querySelector<HTMLButtonElement>(".app-shell__account-menu")?.focus(); } }}
              className="menu shell-account-menu"
            >
              <button
                type="button"

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
        <button className="icon-btn topbar-nav-toggle" aria-label={mobileOpen ? "关闭导航" : "展开导航"} aria-expanded={narrow ? mobileOpen : !collapsed} title="展开 / 收起导航（⌘/Ctrl+B）" onClick={toggleSidebar}><Icon name="panel-left" size={14} /></button>
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
          <button type="button" aria-label="搜索页面与操作" title="搜索页面与操作（⌘/Ctrl+K）" onClick={openPalette}><Icon name="search" size={14} /></button>
          <button
            type="button"
            aria-label="切换深色 / 浅色主题"
            title="切换深色 / 浅色主题"
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "moon" : "sun"} size={14} />
          </button>
        </div>
      </header>

      <main className="app-shell__body" id="main">
        <Outlet />
      </main>
      <dialog className="command-palette" ref={shortcutsRef} aria-label="键盘快捷键" onClick={event => { if (event.target === event.currentTarget) shortcutsRef.current?.close(); }}>
        <div className="command-inner shortcuts-help">
          <h2>键盘快捷键</h2>
          <dl><div><dt>搜索页面与操作</dt><dd>⌘ / Ctrl + K</dd></div><div><dt>展开或收起导航</dt><dd>⌘ / Ctrl + B</dd></div><div><dt>查看快捷键</dt><dd>?</dd></div><div><dt>切换焦点</dt><dd>Tab / Shift + Tab</dd></div><div><dt>关闭弹层</dt><dd>Esc</dd></div></dl>
          <button className="btn" onClick={() => shortcutsRef.current?.close()}>关闭快捷键</button>
        </div>
      </dialog>
      <dialog className="command-palette" ref={paletteRef} aria-label="搜索页面与操作" onClick={event => { if (event.target === event.currentTarget) paletteRef.current?.close(); }}>
        <div className="command-inner">
          <div className="command-search"><input aria-label="搜索命令" placeholder="搜索页面与当前页操作" value={commandQuery} onChange={e => setCommandQuery(e.target.value)} onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { const command = commands.find(c => c.label.toLowerCase().includes(commandQuery.toLowerCase())); if (command) { e.preventDefault(); paletteRef.current?.close(); command.run(); } }
          }} /><button className="icon-btn" aria-label="关闭命令搜索" onClick={() => paletteRef.current?.close()}><Icon name="x" size={14} /></button></div>
          <div className="command-results">{commands.filter(c => c.label.toLowerCase().includes(commandQuery.toLowerCase())).map(c => <button key={c.label} onClick={() => { paletteRef.current?.close(); c.run(); }}>{c.label}</button>)}{!commands.some(c => c.label.toLowerCase().includes(commandQuery.toLowerCase())) && <p>没有匹配的操作</p>}</div>
          <p className="command-help">⌘/Ctrl+K 搜索 · ⌘/Ctrl+B 导航 · Esc 关闭</p>
        </div>
      </dialog>
    </div>
  );
}
