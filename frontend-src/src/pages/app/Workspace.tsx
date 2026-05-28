import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth";
import { fetchRecordings, fetchTasks } from "@/api/endpoints";
import { PageHead } from "@/components/PageHead";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "凌晨好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function Workspace() {
  const { user } = useAuth();
  const recordings = useQuery({
    queryKey: ["recordings", "mine"],
    queryFn: () => fetchRecordings({ scope: "mine" }),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchTasks(),
  });

  const total = recordings.data?.length ?? 0;
  const inFlight = tasks.data?.filter((t) => t.status === "running" || t.status === "queued").length ?? 0;

  return (
    <div className="page-body page--landing">
      <PageHead title={`${greeting()}，${user?.name ?? "你"}。`} />

      <div className="action-tile-grid">
        <Link className="action-tile" to="/app/recordings/new">
          <h3 className="action-tile__title">录音转写</h3>
          <p className="action-tile__body">
            上传客户访谈或内部会议，AI 自动断句、分发言并生成结构化纪要。可在结果页确认说话人与关联商机。
          </p>
          <p className="action-tile__meta">支持 .m4a · .mp3 · .wav · .aac · .mp4</p>
        </Link>
        <Link className="action-tile" to="/app/recordings">
          <h3 className="action-tile__title">录音库</h3>
          <p className="action-tile__body">
            查看你或团队的全部录音，下载逐字稿、纪要、调研要点；按客户、商机筛选。
          </p>
          <p className="action-tile__meta">{total > 0 ? `当前 ${total} 条录音` : "暂无录音"}</p>
        </Link>
        <Link className="action-tile" to="/app/tasks">
          <h3 className="action-tile__title">任务进度</h3>
          <p className="action-tile__body">
            追踪转写、纪要、CRM 同步等长耗时任务；失败任务可一键重跑。
          </p>
          <p className="action-tile__meta">
            {inFlight > 0 ? `当前 ${inFlight} 个进行中` : "近期没有进行中任务"}
          </p>
        </Link>
        <Link className="action-tile" to="/app/hotwords">
          <h3 className="action-tile__title">热词与术语</h3>
          <p className="action-tile__body">
            维护语音识别的客户、产品、行业术语库。开启 CRM / 企微同步后会自动追加候选。
          </p>
          <p className="action-tile__meta">从 CRM、企微日报、本地素材按需挖掘</p>
        </Link>
        <Link className="action-tile" to="/app/voiceprints">
          <h3 className="action-tile__title">声纹样本</h3>
          <p className="action-tile__body">
            登记常出现的声纹，新录音会自动标注说话人；可在录音页用一段发言保存为样本。
          </p>
          <p className="action-tile__meta">最短 5 秒可用 · 推荐 30 秒以上</p>
        </Link>
      </div>
    </div>
  );
}
