import { Navigate, useLocation } from "react-router-dom";
import { PageLoading } from "./PageLoading";
import { useAuth } from "@/context/auth";
import type { Role } from "@/api/types";

// Gate. `roles` = which roles may enter; omit = any authenticated user.
// `requirePasswordChanged` defaults true; the change-password page itself
// bypasses by setting it to false explicitly.
export function ProtectedRoute({
  children,
  roles,
  requirePasswordChanged = true,
}: {
  children: React.ReactNode;
  roles?: Role[];
  requirePasswordChanged?: boolean;
}) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return <PageLoading />;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (requirePasswordChanged && user.must_change_password) {
    return <Navigate to="/auth/change-password" replace />;
  }
  if (roles && !roles.includes(user.role)) {
    // The user is logged in but not authorized for THIS path. Send them home
    // based on their role rather than dropping them to login.
    return <Navigate to={user.role === "admin" ? "/admin/overview" : "/app/workspace"} replace />;
  }
  return <>{children}</>;
}
