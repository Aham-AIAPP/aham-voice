import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchMcpConfig } from "@/api/endpoints";
import { Button } from "@/components/Button";
import { Status } from "@/components/Status";
import { Diag } from "@/components/Diag";
import { Icon } from "@/components/Icon";

/** How to point Claude Desktop at this app.
 *
 * The paths differ between a dev checkout and an installed .app — and the
 * bundle path contains a space — so they are resolved by the backend and shown
 * here rather than written down in a doc the DMG user never sees.
 */
export function McpCard() {
  const [copied, setCopied] = useState(false);
  const config = useQuery({ queryKey: ["mcp-config"], queryFn: fetchMcpConfig });
  const data = config.data;

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card stack-card">
      <div className="row">
        <h3 className="text-subhead form-section__title">接 AI 助手（MCP）</h3>
        <Status tone={data?.script_exists ? "moss" : "muted"}>
          {data?.script_exists ? `${data.tool_count} 个工具` : "检查中"}
        </Status>
      </div>

      <p className="text-caption t-2" style={{ margin: 0 }}>
        让 Claude Desktop 这类客户端在本机驱动这个应用：导入录音、按你说的背景给这次会议定制热词、开始转写、读逐句稿与纪要、管声纹。
        全程只走 127.0.0.1，音频和数据不出本机；<strong>应用没打开时所有工具都会失败</strong>。
      </p>

      <div style={{ display: "grid", gap: 4 }}>
        <span className="text-caption t-2">
          1. 把下面这段加进客户端配置文件（没有就新建）：
        </span>
        <code className="text-caption" style={{ wordBreak: "break-all", opacity: 0.8 }}>
          {data?.client_config_path ?? "…"}
        </code>
      </div>

      <pre
        className="text-caption"
        style={{
          margin: 0,
          padding: "var(--s3)",
          background: "var(--surface-2, rgba(127,127,127,.08))",
          borderRadius: "var(--r-md, 6px)",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {data?.snippet ?? "读取中…"}
      </pre>

      <div className="row">
        <Button variant="primary" size="sm" onClick={copy} disabled={!data}>
          <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "已复制" : "复制配置"}
        </Button>
        <span className="text-caption t-2">2. 重启客户端即可。</span>
      </div>

      {data && !data.uv_found && (
        <Diag code="MCP_UV" tone="info">
          没找到 uv（配置里写的是裸命令 <code>uv</code>，客户端不一定能在 PATH 里找到它）。
          装一个：<code>curl -LsSf https://astral.sh/uv/install.sh | sh</code>，
          或把 command 换成你自己 venv 里的 python 绝对路径。
        </Diag>
      )}
      {data && !data.script_exists && (
        <Diag code="MCP_E">找不到 MCP 服务脚本：{data.script_path}</Diag>
      )}
    </section>
  );
}
