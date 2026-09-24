import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
const tabs = [
  { id: "management", label: "连接管理" },
  { id: "history", label: "操作记录" },
] as const;
export function AiConnections() {
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("management");
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(true),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState<string>(),
    [guide, setGuide] = useState<string>();
  const focused = useRef<HTMLElement>(null);
  const returnTo = useRef<string | undefined>(undefined);
  const selected = connections.find((connection) =>
    [connection.id, `replace:${connection.id}`].includes(guide ?? ""),
  );
  const keyGuide = guide === "key" || guide?.startsWith("replace:");
  function closeGuide() {
    returnTo.current = guide;
    setGuide(undefined);
  }
  function changeTab(next: (typeof tabs)[number]["id"]) {
    if (next !== tab) setGuide(undefined);
    setTab(next);
  }
  useLayoutEffect(() => {
    if (guide)
      focused.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (returnTo.current) {
      const opener = document.getElementById(`ai-open-${returnTo.current}`);
      (opener ?? tabButtons.current[0])?.focus();
      returnTo.current = undefined;
    }
  }, [guide]);
  const load = async () => {
    setLoading(true);
    try {
      const result = await api<Connection[]>("/ai/connections");
      setConnections(result);
      setLoaded(true);
      setLoadError("");
    } catch (e) {
      setLoadError(describeError(e));
      throw e;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load().catch(() => {});
  }, []);
  async function revoke(id: string, closeConfiguration = false) {
    setBusy(id);
    setError("");
    try {
      await api(`/ai/connections/${id}/revoke`, {});
      setConnections((current) =>
        current.map((connection) =>
          connection.id === id
            ? { ...connection, revokedAt: Date.now(), canRevealKey: false }
            : connection,
        ),
      );
      if (closeConfiguration) closeGuide();
      await load().catch(() => {});
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
      await load().catch(() => {});
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
      </div>
      <div className="ai-tabs" role="tablist" aria-label="AI 连接">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabButtons.current[index] = element;
            }}
            className="secondary"
            id={`ai-tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`ai-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => changeTab(item.id)}
            onKeyDown={(event) => {
              let next: number;
              switch (event.key) {
                case "ArrowLeft":
                  next = (index + tabs.length - 1) % tabs.length;
                  break;
                case "ArrowRight":
                  next = (index + 1) % tabs.length;
                  break;
                case "Home":
                  next = 0;
                  break;
                case "End":
                  next = tabs.length - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              changeTab(tabs[next].id);
              tabButtons.current[next]?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id="ai-panel-management"
        role="tabpanel"
        aria-labelledby="ai-tab-management"
        tabIndex={0}
        hidden={tab !== "management"}
      >
        {!guide && (
          <div className="ai-connection-actions">
            <button
              id="ai-open-new"
              className="primary"
              onClick={() => setGuide("new")}
            >
              连接 Codex
            </button>
            <button
              id="ai-open-key"
              className="secondary"
              onClick={() => setGuide("key")}
            >
              通过 Node 连接
            </button>
            <button
              className="secondary"
              disabled={!!busy || loading}
              onClick={() => {
                setError("");
                void load().catch(() => {});
              }}
            >
              刷新连接
            </button>
          </div>
        )}
        <Message error>{error}</Message>
        {loadError && (
          <div>
            <Message error>连接加载失败：{loadError}</Message>
            {loaded && (
              <p className="muted">当前显示上次加载的连接，状态可能已变化。</p>
            )}
            <button
              className="secondary"
              disabled={loading || !!busy}
              onClick={() => void load().catch(() => {})}
            >
              重试加载连接
            </button>
          </div>
        )}
        {loading && <Message>正在加载连接…</Message>}
        {guide ? (
          <section
            ref={focused}
            className="ai-focused-configuration"
            aria-label="连接配置"
          >
            {keyGuide ? (
              <AiKeyCreate
                key={guide}
                reloadConnections={load}
                connections={connections}
                replacement={
                  guide.startsWith("replace:") ? selected : undefined
                }
                onRevokeOld={revoke}
                onRevoke={(id) => revoke(id, true)}
                revoking={!!busy}
                onClose={closeGuide}
              />
            ) : (
              <>
                <button className="secondary" onClick={closeGuide}>
                  返回连接管理
                </button>
                <h2>{selected ? "重新授权 Codex" : "连接 Codex"}</h2>
                <AiConnectionGuide
                  key={guide}
                  scopes={selected?.scopes ?? ["progress:read", "drafts:write"]}
                  reconnect={!!selected}
                />
                <p className="field-hint">
                  若已使用 Node 连接日序，建议只启用一条连接，以免工具重复。
                </p>
              </>
            )}
          </section>
        ) : (
          <section
            className="ai-connection-section"
            aria-label="已有连接"
            aria-busy={loading}
          >
            <h2>已有连接</h2>
            {loaded && !loading && !loadError && !connections.length && (
              <p className="empty">暂无连接。</p>
            )}
            <div className="ai-connection-list">
              {connections.map((connection) => {
                const status =
                  connection.revokedAt !== null
                    ? "已撤销"
                    : connection.lastReadSucceededAt !== null
                      ? "已连接"
                      : connection.credentialType === "api-key"
                        ? "待测试"
                        : "已授权";
                return (
                  <article
                    className="account-card ai-connection-card"
                    key={connection.id}
                  >
                    <div className="ai-connection-info">
                      <div className="ai-connection-primary">
                        <h3>
                          {connection.credentialType === "api-key"
                            ? connection.name
                            : "Codex"}
                        </h3>
                        <span className="ai-connection-type">
                          {connection.credentialType === "api-key"
                            ? "Node · 授权 Key"
                            : "OAuth"}
                        </span>
                        <span
                          className="ai-connection-status"
                          data-status={status}
                        >
                          {status}
                        </span>
                      </div>
                      <p>
                        {connection.scopes
                          .map((scope) => labels[scope] ?? scope)
                          .join(" · ")}
                      </p>
                      <p>
                        最近成功查询：
                        {connection.lastReadSucceededAt === null
                          ? "暂无"
                          : new Date(
                              connection.lastReadSucceededAt,
                            ).toLocaleString("zh-CN")}
                      </p>
                      <p>
                        创建：
                        {new Date(connection.createdAt).toLocaleString(
                          "zh-CN",
                        )}{" "}
                        · 最近活动：
                        {new Date(connection.lastUsedAt).toLocaleString(
                          "zh-CN",
                        )}
                      </p>
                      {connection.credentialType === "api-key" &&
                        connection.revokedAt !== null && (
                          <p>需要再次连接时，请生成新的授权 Key。</p>
                        )}
                      {connection.credentialType === "api-key" &&
                        connection.revokedAt === null &&
                        connection.lastReadSucceededAt === null && (
                          <p>请让 Codex 列出项目，再刷新连接。</p>
                        )}
                    </div>
                    <div className="ai-connection-row-actions">
                      {connection.revokedAt !== null ? (
                        <>
                          {connection.credentialType === "oauth" && (
                            <button
                              className="secondary"
                              disabled={!!busy || loading}
                              id={`ai-open-${connection.id}`}
                              onClick={() => setGuide(connection.id)}
                            >
                              重新授权
                            </button>
                          )}
                          <button
                            className="text-button danger"
                            disabled={!!busy || loading}
                            onClick={() => void deleteRevoked(connection.id)}
                          >
                            {busy === connection.id ? "正在删除…" : "删除记录"}
                          </button>
                        </>
                      ) : (
                        <>
                          {connection.credentialType === "api-key" && (
                            <button
                              className="secondary"
                              disabled={!!busy || loading}
                              id={`ai-open-replace:${connection.id}`}
                              onClick={() =>
                                setGuide(`replace:${connection.id}`)
                              }
                            >
                              更换 Key / 调整能力
                            </button>
                          )}
                          <button
                            className="secondary"
                            disabled={!!busy || loading}
                            onClick={() => void revoke(connection.id)}
                          >
                            {busy === connection.id ? "正在撤销…" : "撤销连接"}
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </div>
      <div
        id="ai-panel-history"
        role="tabpanel"
        aria-labelledby="ai-tab-history"
        tabIndex={0}
        hidden={tab !== "history"}
      >
        {tab === "history" && <AiHistory />}
      </div>
    </>
  );
}
