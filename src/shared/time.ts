export const beijingDate = (time: number) =>
  new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export const beijingToday = () => beijingDate(Date.now());
export const formatDate = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
    hour12: false,
  }).format(time);
