import { Link } from "react-router-dom";
import { Button } from "@/components/Button";

export function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-canvas)",
        padding: "var(--space-10)",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <h1 style={{ fontSize: "var(--text-3xl)", fontWeight: 600 }}>找不到这一页</h1>
        <p style={{ color: "var(--fg-muted)", marginTop: "var(--space-2)" }}>
          地址可能已变更，或权限范围不再包含。
        </p>
        <div style={{ marginTop: "var(--space-6)" }}>
          <Link to="/">
            <Button variant="primary">回到起点</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
