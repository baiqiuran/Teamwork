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
  lastReadSucceededAt: number | null;
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
  const load = async () => {
    const result = await api<Connection[]>("/ai/connections");
    setConnections(result);
  };
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
  async function deleteRevoked(id: string) {
    if (!window.confirm("删除这条已撤销授权记录？操作历史仍会保留。")) return;
    setBusy(id);
    setError("");
    try {
      await api(`/ai/connections/${id}/delete`, {});
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
        <h1>AI 连接</h1>
        <p className="subtitle">每个连接单独授权；撤销立即生效。</p>
        <div className="ai-connection-actions">
          <button
            className="primary"
            onClick={() => setGuide(guide === "new" ? undefined : "new")}
          >
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
      {guide === "key" && (
        <AiKeyCreate reloadConnections={load} connections={connections} />
      )}
      {guide === "new" && (
        <AiConnectionGuide scopes={["progress:read", "drafts:write"]} />
      )}
      <section className="ai-connection-section" aria-label="已有连接">
        <h2>已有连接</h2>
        {!connections.length && <p className="empty">暂无连接。</p>}
        <div className="ai-connection-list">
          {connections.map((connection) => (
            <article
              className="account-card ai-connection-card"
              key={connection.id}
            >
              <h2>
                {connection.credentialType === "api-key"
                  ? connection.name
                  : "Codex"}
              </h2>
              {connection.credentialType === "api-key" && (
                <p>Node · 授权 Key</p>
              )}
              <p>
                {connection.scopes.map((scope) => labels[scope]).join(" · ")}
              </p>
              <p>
                创建：{new Date(connection.createdAt).toLocaleString("zh-CN")} ·
                最近活动：
                {new Date(connection.lastUsedAt).toLocaleString("zh-CN")}
              </p>
              {connection.credentialType === "api-key" &&
                connection.revokedAt === null && (
                  <p>
                    {connection.lastReadSucceededAt === null
                      ? "待测试：请让 Codex 列出项目，再刷新连接。"
                      : `已连接：只读查询成功于 ${new Date(connection.lastReadSucceededAt).toLocaleString("zh-CN")}`}
                  </p>
                )}
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
                  <button
                    className="text-button danger"
                    disabled={!!busy}
                    onClick={() => void deleteRevoked(connection.id)}
                  >
                    删除记录
                  </button>
                </>
              ) : (
                <>
                  {connection.credentialType === "api-key" && (
                    <button
                      className="secondary"
                      aria-expanded={guide === `replace:${connection.id}`}
                      onClick={() =>
                        setGuide(
                          guide === `replace:${connection.id}`
                            ? undefined
                            : `replace:${connection.id}`,
                        )
                      }
                    >
                      更换 Key / 调整能力
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void revoke(connection.id)}
                  >
                    {busy === connection.id ? "正在撤销…" : "撤销连接"}
                  </button>
                </>
              )}
              {guide === `replace:${connection.id}` && (
                <AiKeyCreate
                  reloadConnections={load}
                  connections={connections}
                  replacement={connection}
                  onRevokeOld={revoke}
                />
              )}
            </article>
          ))}
        </div>
      </section>
      <AiHistory />
    </>
  );
}
