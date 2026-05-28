import { createBrowserRouter, Navigate } from "react-router-dom";
import { AuthShell } from "@/layouts/AuthShell";
import { AppShell } from "@/layouts/AppShell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Login } from "@/pages/auth/Login";
import { ChangePassword } from "@/pages/auth/ChangePassword";
import { Workspace } from "@/pages/app/Workspace";
import { RecordingsList } from "@/pages/app/RecordingsList";
import { RecordingNew } from "@/pages/app/RecordingNew";
import { RecordingDetail } from "@/pages/app/RecordingDetail";
import { Tasks } from "@/pages/app/Tasks";
import { Hotwords } from "@/pages/app/Hotwords";
import { Voiceprints } from "@/pages/app/Voiceprints";
import { AdminOverview } from "@/pages/admin/Overview";
import { AdminUsers } from "@/pages/admin/Users";
import { AdminTeams } from "@/pages/admin/Teams";
import { AdminPermissions } from "@/pages/admin/Permissions";
import { AdminWecom } from "@/pages/admin/Wecom";
import { AdminAudit } from "@/pages/admin/Audit";
import { AdminVoiceprints } from "@/pages/admin/Voiceprints";
import { AdminHotwords } from "@/pages/admin/Hotwords";
import { AdminHotwordSources } from "@/pages/admin/HotwordSources";
import { AdminPlaceholder } from "@/pages/admin/Placeholder";
import { NotFound } from "@/pages/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/app/workspace" replace />,
  },
  {
    path: "/login",
    element: <AuthShell />,
    children: [{ index: true, element: <Login /> }],
  },
  {
    path: "/auth",
    element: <AuthShell />,
    children: [
      {
        path: "change-password",
        element: (
          <ProtectedRoute requirePasswordChanged={false}>
            <ChangePassword />
          </ProtectedRoute>
        ),
      },
    ],
  },
  {
    path: "/app",
    element: (
      <ProtectedRoute roles={["member", "manager"]}>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/app/workspace" replace /> },
      { path: "workspace", element: <Workspace /> },
      { path: "recordings", element: <RecordingsList /> },
      { path: "recordings/new", element: <RecordingNew /> },
      { path: "recordings/:id", element: <RecordingDetail /> },
      { path: "tasks", element: <Tasks /> },
      { path: "hotwords", element: <Hotwords /> },
      { path: "voiceprints", element: <Voiceprints /> },
    ],
  },
  {
    path: "/admin",
    element: (
      <ProtectedRoute roles={["admin"]}>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/admin/overview" replace /> },
      { path: "overview", element: <AdminOverview /> },
      { path: "users", element: <AdminUsers /> },
      { path: "teams", element: <AdminTeams /> },
      { path: "permissions", element: <AdminPermissions /> },
      { path: "wecom", element: <AdminWecom /> },
      { path: "audit", element: <AdminAudit /> },
      { path: "voiceprints", element: <AdminVoiceprints /> },
      { path: "hotword", element: <AdminHotwords /> },
      { path: "hotword-sources", element: <AdminHotwordSources /> },
      { path: "asr", element: <AdminPlaceholder route="/admin/asr" title="ASR 配置" needs="GET/PATCH /api/admin/asr 接口未在后端定义。" /> },
      { path: "llm", element: <AdminPlaceholder route="/admin/llm" title="大模型配置" needs="GET/PATCH /api/admin/llm 接口未在后端定义。" /> },
      { path: "storage", element: <AdminPlaceholder route="/admin/storage" title="存储" needs="GET /api/admin/storage 接口未在后端定义。" /> },
      { path: "storage-queue", element: <AdminPlaceholder route="/admin/storage-queue" title="队列" needs="GET /api/admin/storage/queue 接口未在后端定义。" /> },
      { path: "export", element: <AdminPlaceholder route="/admin/export" title="导出" needs="GET /api/admin/export 接口未在后端定义。" /> },
      { path: "export-templates", element: <AdminPlaceholder route="/admin/export-templates" title="导出模板" needs="GET/POST /api/admin/export-templates 接口未在后端定义。" /> },
    ],
  },
  {
    path: "*",
    element: <NotFound />,
  },
]);
