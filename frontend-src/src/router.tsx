import { createBrowserRouter, Navigate } from "react-router-dom";
import { AuthShell } from "@/layouts/AuthShell";
import { AppShell } from "@/layouts/AppShell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Login } from "@/pages/auth/Login";
import { ChangePassword } from "@/pages/auth/ChangePassword";
import { RecordingsList } from "@/pages/app/RecordingsList";
import { RecordingNew } from "@/pages/app/RecordingNew";
import { RecordingDetail } from "@/pages/app/RecordingDetail";
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
import { AdminSettings } from "@/pages/admin/Settings";
import { NotFound } from "@/pages/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/app/recordings/new" replace />,
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
      { index: true, element: <Navigate to="/app/recordings/new" replace /> },
      { path: "workspace", element: <Navigate to="/app/recordings/new" replace /> },
      { path: "recordings", element: <RecordingsList /> },
      { path: "recordings/new", element: <RecordingNew /> },
      { path: "recordings/:id", element: <RecordingDetail /> },
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
      { path: "llm", element: <AdminSettings /> },
    ],
  },
  {
    path: "*",
    element: <NotFound />,
  },
]);
