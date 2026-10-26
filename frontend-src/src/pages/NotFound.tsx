import { Link } from "react-router-dom";
import { Button } from "@/components/Button";

export function NotFound() {
  return (
    <div className="u-flex u-items-center u-justify-center nf-page">
      <div className="u-text-center nf-card">
        <h1 className="u-fs-3xl u-fw-600">找不到这一页</h1>
        <p className="u-fg-muted u-mt-2">
          地址可能已变更，或权限范围不再包含。
        </p>
        <div className="u-mt-6">
          <Link to="/">
            <Button variant="primary">回到起点</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
