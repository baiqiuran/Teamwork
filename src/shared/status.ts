import type { TaskStatus } from "./contracts";
export const statusLabels: Record<TaskStatus, string> = {
  pending: "待开始",
  "in-progress": "进行中",
  done: "已完成",
};
