import { Hotwords } from "@/pages/app/Hotwords";

// 管理员热词管理与用户端完全一致：同一个简洁的个人热词页（文本框 +「、」分隔 + 导入 txt + 保存）。
// 已移除外部同步、热词来源、评分重算等本机部署中无对接、不可用的死功能。
export function AdminHotwords() {
  return <Hotwords />;
}
