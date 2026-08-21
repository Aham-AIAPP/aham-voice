import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { Button } from "@/components/Button";

function errorMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText || "页面加载失败"}`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "页面加载时出现异常。";
}

export function AppError() {
  const error = useRouteError();

  return (
    <main className="u-flex u-items-center u-justify-center nf-page">
      <section className="u-text-center nf-card" role="alert">
        <h1 className="u-fs-3xl u-fw-600">页面暂时无法打开</h1>
        <p className="u-fg-muted u-mt-2">{errorMessage(error)}</p>
        <p className="meta u-mt-2">请刷新加载最新版本；如果仍然失败，可返回录音库后重试。</p>
        <div className="u-mt-6 u-cluster u-justify-center">
          <Button variant="primary" onClick={() => window.location.reload()}>刷新页面</Button>
          <Button variant="ghost" onClick={() => window.location.assign("/app/recordings")}>返回录音库</Button>
        </div>
      </section>
    </main>
  );
}
