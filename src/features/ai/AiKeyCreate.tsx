import { useState } from "react";
import { api } from "../../shared/api";
import { describeError } from "../../shared/errors";
import { Message } from "../../shared/components/Message";

const options = [
  ["progress:read", "查询团队工作进展"],
  ["drafts:write", "读写本人日报草稿"],
  ["diaries:submit", "提交本人日报"],
  ["tasks:write", "创建任务和更新任务状态"],
  ["shares:manage", "创建和关闭本人公开链接"],
] as const;
const advancedDescriptions: Record<string, string> = {
  "diaries:submit": "正式提交本人日报，并更新关联项目的公开进展。",
  "tasks:write": "创建任务或更新状态，可能改变公开任务列表。",
  "shares:manage": "创建或关闭本人公开链接，让持链接者查看所选范围。",
};

export function AiKeyCreate({
  reloadConnections,
  connections,
  replacement,
  onRevokeOld,
}: {
  reloadConnections: () => Promise<unknown>;
  connections: Array<{ id: string; lastReadSucceededAt: number | null }>;
  replacement?: {
    id: string;
    name: string | null;
    scopes: string[];
    revokedAt: number | null;
  };
  onRevokeOld?: (id: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(
    replacement
      ? `${replacement.name ?? "Node 连接"}（新）`
      : "我的 Node 客户端",
  );
  const [scopes, setScopes] = useState<string[]>([
    ...(replacement
      ? [...new Set(["progress:read", ...replacement.scopes])]
      : ["progress:read", "drafts:write"]),
  ]);
  const [key, setKey] = useState("");
  const [keyId, setKeyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [packagePath, setPackagePath] = useState("");
  const connected = connections.some(
    (connection) =>
      connection.id === keyId && connection.lastReadSucceededAt !== null,
  );
  const configuration = [
    "[mcp_servers.daily_flow_node]",
    'command = "cmd"',
    `args = ${JSON.stringify(["/c", "npx", "--yes", `--package=${packagePath.trim().replaceAll("\\", "/")}`, "daily-flow-mcp"])}`,
    "",
    "[mcp_servers.daily_flow_node.env]",
    `DAILY_FLOW_URL = ${JSON.stringify(`${window.location.origin}/mcp`)}`,
    `DAILY_FLOW_API_KEY = ${JSON.stringify(key)}`,
  ].join("\n");
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ key: string; id: string }>("/ai/keys", {
        name,
        scopes,
      });
      setKey(result.key);
      setKeyId(result.id);
      await reloadConnections();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy(value = key, label = "Key") {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`已复制${label}。`);
    } catch {
      setFeedback(`无法自动复制，请选中${label}手动复制。`);
    }
  }
  async function check() {
    setError("");
    try {
      await reloadConnections();
    } catch (e) {
      setError(describeError(e));
    }
  }
  function scopeOption([scope, label]: (typeof options)[number]) {
    return (
      <label key={scope} style={{ display: "flex", gap: 12, marginBlock: 16 }}>
        <input
          type="checkbox"
          checked={scopes.includes(scope)}
          disabled={scope === "progress:read"}
          onChange={(event) =>
            setScopes((current) =>
              event.target.checked
                ? [...current, scope]
                : current.filter((value) => value !== scope),
            )
          }
        />
        <span>
          {label}
          {advancedDescriptions[scope] && (
            <small className="field-hint">{advancedDescriptions[scope]}</small>
          )}
        </span>
      </label>
    );
  }
  return (
    <section
      className="ai-connection-guide"
      aria-label={replacement ? "更换 Node 授权 Key" : "Node 授权 Key"}
    >
      <h2>{replacement ? "更换 Key / 调整能力" : "通过 Node 连接"}</h2>
      <Message error>{error}</Message>
      {replacement && (
        <p>
          旧连接：{replacement.name ?? "未命名"} · 当前能力：
          {replacement.scopes
            .map(
              (scope) =>
                options.find(([value]) => value === scope)?.[1] ?? scope,
            )
            .join(" · ")}
          。旧 Key 不会再次显示。
          {replacement.revokedAt === null &&
            "新 Key 测试成功前，旧 Key 仍可使用。"}
        </p>
      )}
      {keyId ? (
        <>
          {key ? (
            <>
              <p>Key 仅显示一次。关闭或刷新页面后无法再查看。</p>
              <p>
                下面的 Codex 配置包含明文
                Key。只保存在本机用户级配置中，不要提交到仓库或写入日志。
              </p>
              <label>
                授权 Key
                <textarea readOnly value={key} rows={2} spellCheck={false} />
              </label>
              <button className="secondary" onClick={() => void copy()}>
                复制 Key
              </button>
              <Message>{feedback}</Message>
              <label>
                服务地址
                <input readOnly value={`${window.location.origin}/mcp`} />
              </label>
              <label>
                本地包路径
                <input
                  value={packagePath}
                  onChange={(event) => setPackagePath(event.target.value)}
                  placeholder="C:/tools/daily-flow-mcp-0.1.0.tgz"
                  spellCheck={false}
                />
              </label>
              <p>
                从管理员处获取 <code>daily-flow-mcp-0.1.0.tgz</code>
                ，放在本机并填写绝对路径。 在 Windows 的 Codex 用户级配置{" "}
                <code>%USERPROFILE%\.codex\config.toml</code>
                {replacement
                  ? " 中用下面的片段替换原 daily_flow_node 配置，避免保留两个同名区块；然后重启 Codex。"
                  : " 末尾粘贴下面的片段，再重启 Codex。"}
                首次启动可能需要联网获取依赖。
              </p>
              <label htmlFor="node-mcp-configuration">Codex 配置</label>
              <textarea
                id="node-mcp-configuration"
                readOnly
                value={
                  packagePath.trim() ? configuration : "请先填写本地包路径。"
                }
                rows={8}
                spellCheck={false}
              />
              <button
                className="primary"
                disabled={!packagePath.trim()}
                onClick={() => void copy(configuration, "Codex 配置")}
              >
                复制 Codex 配置
              </button>
            </>
          ) : (
            <p>Key 已隐藏。若尚未保存配置，请重新生成一条新 Key。</p>
          )}
          <p>
            在 Codex 输入 <code>/mcp</code> 确认连接，再请 Codex
            使用日序工具列出项目。这是只读测试，不会修改工作数据。
          </p>
          <p>
            {connected
              ? "已连接：这个 Key 已完成一次只读查询。"
              : "待测试：完成列出项目后，点击下方按钮检查结果。即使项目为空也算成功。"}
          </p>
          {!connected && (
            <>
              <button className="secondary" onClick={() => void check()}>
                检查查询结果
              </button>
              <p>
                仍显示待测试？请确认 Node 包能启动、已重启
                Codex、服务地址和网络可达，且配置中的 Key
                与当前显示的一致。修正配置后可再次列出项目，现有 Key 仍可使用。
              </p>
            </>
          )}
          {replacement &&
            connected &&
            (replacement.revokedAt === null ? (
              <>
                <p>
                  新 Key 已验证。请撤销旧 Key，结束两条连接同时有效的过渡期。
                </p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void onRevokeOld?.(replacement.id)}
                >
                  撤销旧 Key
                </button>
              </>
            ) : (
              <p>旧 Key 已撤销，新 Key 可继续使用。</p>
            ))}
          <p>
            若已使用 Codex OAuth 连接日序，建议只启用一条连接，以免工具重复。
          </p>
          {key && (
            <button
              className="secondary"
              onClick={() => {
                setKey("");
                setFeedback("");
              }}
            >
              我已保存，隐藏 Key
            </button>
          )}
        </>
      ) : (
        <>
          <label>
            连接名称
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset disabled={busy}>
            <legend>授权能力</legend>
            <p>连接确认需要查询能力；此能力已勾选且不可取消。</p>
            {options.slice(0, 2).map(scopeOption)}
            <details>
              <summary>更多权限</summary>
              {options.slice(2).map(scopeOption)}
            </details>
          </fieldset>
          <p>
            Key
            以你的身份访问，直到撤销。提交、任务和分享能力可能更新已有公开页。
          </p>
          <button
            className="primary"
            disabled={busy || !name.trim() || !scopes.length}
            onClick={() => void create()}
          >
            {busy ? "正在生成…" : "生成授权 Key"}
          </button>
        </>
      )}
    </section>
  );
}
