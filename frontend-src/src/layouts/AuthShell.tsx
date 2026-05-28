import { Outlet } from "react-router-dom";

// .auth-shell — full-viewport, centered, no sidebar, no nav, no dock.
// One shape serves login, change password, reset password, first-run setup.
export function AuthShell() {
  return (
    <div className="auth-shell">
      <div className="auth-shell__brand">
        <span className="brand-mark">A</span>
        <span>
          兰之天 <em>AI · 录音转写</em>
        </span>
      </div>
      <Outlet />
    </div>
  );
}
