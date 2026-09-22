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

export function AiKeyCreate({
  onCreated,
}: {
  onCreated: () => Promise<unknown>;
}) {
  const [name, setName] = useState("我的 Node 客户端");
  const [scopes, setScopes] = useState<string[]>([
    "progress:read",
    "drafts:write",
  ]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const windows = navigator.userAgent.includes("Windows");
  const [packagePath, setPackagePath] = useState(
    windows
      ? "C:/tools/daily-flow-mcp-0.1.0.tgz"
      : "/path/to/daily-flow-mcp-0.1.0.tgz",
  );
  const configuration = JSON.stringify(
    {
      mcpServers: {
        "daily-flow": {
          command: windows ? "cmd" : "npx",
          args: [
            ...(windows ? ["/c", "npx"] : []),
            "--yes",
            `--package=${packagePath.trim()}`,
            "daily-flow-mcp",
          ],
          env: {
            DAILY_FLOW_URL: `${window.location.origin}/mcp`,
            DAILY_FLOW_API_KEY: key,
          },
        },
      },
    },
    null,
    2,
  );
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ key: string }>("/ai/keys", { name, scopes });
      setKey(result.key);
      await onCreated();
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
  return (
    <section className="ai-connection-guide" aria-label="Node 授权 Key">
      <h2>通过 Node 连接</h2>
      <Message error>{error}</Message>
      {key ? (
        <>
          <p>
            Key 仅在创建时显示。请保存到 AI
            客户端配置中；关闭或刷新后无法再次查看。
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
          <p>
            将管理员提供的 Node 包放到 AI
            客户端所在电脑，填写该电脑上的包路径，再复制配置。首次启动可能需要联网下载依赖。
          </p>
          <label>
            本地包路径
            <input
              value={packagePath}
              onChange={(event) => setPackagePath(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label htmlFor="node-mcp-configuration">MCP 客户端配置</label>
          <textarea
            id="node-mcp-configuration"
            readOnly
            value={configuration}
            rows={12}
            spellCheck={false}
          />
          <button
            className="secondary"
            disabled={!packagePath.trim()}
            onClick={() => void copy(configuration, "客户端配置")}
          >
            复制客户端配置
          </button>
          <button
            className="secondary"
            onClick={() => {
              setKey("");
              setFeedback("");
            }}
          >
            我已保存，隐藏 Key
          </button>
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
            {options.map(([scope, label]) => (
              <label
                key={scope}
                style={{ display: "flex", gap: 12, marginBlock: 16 }}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((value) => value !== scope),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p>
            Key 以你的成员身份访问，持续有效直到撤销。提交、任务和分享能力允许
            AI 自动执行相应操作，并可能更新已有公开页。
          </p>
          <button
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
