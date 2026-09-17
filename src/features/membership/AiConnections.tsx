import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
import { AiHistory } from "./AiHistory";
type Connection = {
  id: string;
  client: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
};
const labels: Record<string, string> = {
  "progress:read": "查询进展",
  "drafts:write": "本人草稿",
  "diaries:submit": "提交日报",
  "tasks:write": "任务变更",
  "shares:manage": "公开分享",
};
export function AiConnections() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string>();
  const load = () => api<Connection[]>("/ai/connections").then(setConnections);
  useEffect(() => {
    load().catch((e) => setError(describeError(e)));
  }, []);
  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await api(`/ai/connections/${id}/revoke`, {});
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <>
      <div className="page-intro">
        <p className="eyebrow">AI 连接</p>
        <h1>管理 Codex 的操作权限</h1>
        <p>每个连接独立授权。撤销后立即停止访问，网页操作不受影响。</p>
      </div>
      <Message error>{error}</Message>
      {!connections.length && <p>尚未授权 AI 连接。</p>}
      {connections.map((connection) => (
        <section
          className="account-card"
          key={connection.id}
          style={{ marginBottom: 16 }}
        >
          <h2>Codex</h2>
          <p>{connection.scopes.map((scope) => labels[scope]).join(" · ")}</p>
          <p>
            创建：{new Date(connection.createdAt).toLocaleString("zh-CN")} ·
            最近活动：{new Date(connection.lastUsedAt).toLocaleString("zh-CN")}
          </p>
          {connection.revokedAt !== null ? (
            <p>已撤销</p>
          ) : (
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => void revoke(connection.id)}
            >
              {busy === connection.id ? "正在撤销…" : "撤销连接"}
            </button>
          )}
        </section>
      ))}
      <AiHistory />
    </>
  );
}
