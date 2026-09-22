import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
import { AiHistory } from "./AiHistory";
import { AiConnectionGuide } from "./AiConnectionGuide";
import { AiKeyCreate } from "./AiKeyCreate";
type Connection = {
  id: string;
  client: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
  credentialType: "oauth" | "api-key";
  name: string | null;
};
const labels: Record<string, string> = {
  "progress:read": "查询团队工作进展",
  "drafts:write": "读写本人日报草稿",
  "diaries:submit": "提交本人日报",
  "tasks:write": "创建任务和更新任务状态",
  "shares:manage": "创建和关闭本人公开链接",
};
export function AiConnections() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string>(),
    [guide, setGuide] = useState<string>();
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
        <h1>管理 AI 的操作权限</h1>
        <p>每个连接独立授权。撤销后立即停止访问，网页操作不受影响。</p>
        <div className="ai-connection-actions">
          <button onClick={() => setGuide(guide === "new" ? undefined : "new")}>
            连接 Codex
          </button>
          <button
            className="secondary"
            onClick={() => setGuide(guide === "key" ? undefined : "key")}
          >
            通过 Node 连接
          </button>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() => {
              setError("");
              void load().catch((e) => setError(describeError(e)));
            }}
          >
            刷新连接
          </button>
        </div>
      </div>
      <Message error>{error}</Message>
      {guide === "key" && <AiKeyCreate onCreated={load} />}
      {guide === "new" && (
        <AiConnectionGuide scopes={["progress:read", "drafts:write"]} />
      )}
      {!connections.length && <p>尚未授权 AI 连接。</p>}
      {connections.map((connection) => (
        <section
          className="account-card"
          key={connection.id}
          style={{ marginBottom: 16 }}
        >
          <h2>
            {connection.credentialType === "api-key"
              ? connection.name
              : "Codex"}
          </h2>
          {connection.credentialType === "api-key" && <p>Node · 授权 Key</p>}
          <p>{connection.scopes.map((scope) => labels[scope]).join(" · ")}</p>
          <p>
            创建：{new Date(connection.createdAt).toLocaleString("zh-CN")} ·
            最近活动：{new Date(connection.lastUsedAt).toLocaleString("zh-CN")}
          </p>
          {connection.revokedAt !== null ? (
            <>
              <p>已撤销</p>
              {connection.credentialType === "api-key" ? (
                <p>需要再次连接时，请生成新的授权 Key。</p>
              ) : (
                <button
                  className="secondary"
                  aria-expanded={guide === connection.id}
                  onClick={() =>
                    setGuide(
                      guide === connection.id ? undefined : connection.id,
                    )
                  }
                >
                  重新授权
                </button>
              )}
              {guide === connection.id && (
                <AiConnectionGuide scopes={connection.scopes} reconnect />
              )}
            </>
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
