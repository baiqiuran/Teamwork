import { useState } from "react";
import { Message } from "../../shared/components/Message";

export function AiConnectionGuide({
  scopes,
  reconnect = false,
}: {
  scopes: string[];
  reconnect?: boolean;
}) {
  const [name, setName] = useState("daily_flow");
  const [feedback, setFeedback] = useState("");
  const validName = /^[a-zA-Z0-9_-]+$/.test(name);
  const command = validName
    ? `codex mcp login ${name} --scopes ${scopes.join(",")}`
    : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setFeedback("命令已复制。请在运行 Codex 的电脑上执行。");
    } catch {
      setFeedback("无法自动复制，请选中下方授权命令手动复制。");
    }
  }
  return (
    <section
      className="ai-connection-guide"
      aria-label={reconnect ? "重新授权 Codex" : "连接 Codex 指引"}
    >
      <h3>{reconnect ? "重新授权 Codex" : "连接 Codex"}</h3>
      <p>
        {reconnect
          ? "旧连接已撤销。请从 Codex 重新发起授权。"
          : "先在 Codex 中配置日序 MCP 服务，再从 Codex 发起授权。"}
      </p>
      <ol>
        <li>在运行 Codex 的电脑上执行下方命令。</li>
        <li>
          打开命令提供的授权链接，登录日序，选择能力并点击“允许所选能力”。
        </li>
        <li>授权完成后刷新连接，并尝试查询工作进展。</li>
      </ol>
      <label>
        Codex 连接名称
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setFeedback("");
          }}
          spellCheck={false}
        />
      </label>
      <p className="field-hint">
        填写 Codex 配置中的连接名称，默认 daily_flow。
      </p>
      {!validName && (
        <Message error>
          连接名称只能包含英文字母、数字、下划线和连字符。
        </Message>
      )}
      <label>
        授权命令
        <textarea readOnly value={command} rows={3} spellCheck={false} />
      </label>
      <button
        className="secondary"
        disabled={!validName}
        onClick={() => void copy()}
      >
        复制授权命令
      </button>
      <Message>{feedback}</Message>
      <p>
        {reconnect
          ? "命令申请原连接的能力，最终以你在授权页勾选的范围为准。"
          : "命令默认申请查询和本人草稿能力。"}
        最终授权范围以授权页勾选为准。
      </p>
    </section>
  );
}
