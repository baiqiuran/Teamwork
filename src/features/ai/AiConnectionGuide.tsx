import { useState } from "react";
import { Message } from "../../shared/components/Message";
import { remoteMcpUrl } from "./remoteMcpUrl";

export function AiConnectionGuide({
  scopes,
  reconnect = false,
}: {
  scopes: string[];
  reconnect?: boolean;
}) {
  const [name, setName] = useState("daily_flow");
  const [serviceAddress, setServiceAddress] = useState(
    `${window.location.origin}/mcp`,
  );
  const [feedback, setFeedback] = useState("");
  const validName = /^[a-zA-Z0-9_-]+$/.test(name);
  const targetUrl = remoteMcpUrl(serviceAddress);
  const differentOrigin =
    targetUrl !== null && new URL(targetUrl).origin !== window.location.origin;
  const configuration =
    validName && targetUrl
      ? [
          `[mcp_servers.${name}]`,
          `url = ${JSON.stringify(targetUrl)}`,
          "",
          `[mcp_servers.${name}.oauth]`,
          'client_id = "daily-flow-codex"',
          'callback_url = "http://127.0.0.1/callback"',
        ].join("\n")
      : "";
  const loginCommand = validName
    ? `codex mcp login ${name} --scopes ${scopes.join(",")}`
    : "";
  const command = reconnect
    ? loginCommand
    : validName && targetUrl
      ? [
          `codex mcp add ${name} --url ${JSON.stringify(targetUrl)} --oauth-client-id daily-flow-codex`,
          `if ($LASTEXITCODE -eq 0) { ${loginCommand} }`,
        ].join("\n")
      : "";
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`已复制${label}。`);
    } catch {
      setFeedback(`无法自动复制，请选中${label}手动复制。`);
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
          ? "旧连接已撤销。核对已有 Codex 连接名称，再重新发起授权。"
          : "填写远程地址，复制一段 PowerShell 命令，就能添加日序服务器并发起本人授权。"}
      </p>
      <ol>
        <li>在运行 Codex 的电脑上执行下方命令。</li>
        <li>
          打开命令提供的授权链接，登录日序，选择能力并点击“允许所选能力”。
        </li>
        <li>
          重启 Codex，输入 /mcp 确认连接，查询工作进展，然后刷新网页连接列表。
        </li>
      </ol>
      {!reconnect && (
        <>
          <label>
            远程 MCP 服务器地址
            <input
              value={serviceAddress}
              onChange={(event) => {
                setServiceAddress(event.target.value);
                setFeedback("");
              }}
              placeholder="https://你的日序站点/mcp"
              spellCheck={false}
              aria-invalid={targetUrl === null}
            />
          </label>
          <p className="field-hint">
            默认是当前日序站点；Codex 所在电脑必须能访问此地址。
          </p>
          {targetUrl === null && (
            <Message error>
              请填写 HTTPS 日序地址或 /mcp 地址；仅本机地址可使用
              HTTP，不能包含账号、查询参数或片段。
            </Message>
          )}
          {differentOrigin && (
            <p className="field-hint">
              请确认这是当前日序服务的公开地址；其他地址可能无法完成授权回调。
            </p>
          )}
        </>
      )}
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
        连接名称默认
        daily_flow；已有同名连接时命令不会覆盖原地址，请先核对或改用新名称。
      </p>
      {!validName && (
        <Message error>
          连接名称只能包含英文字母、数字、下划线和连字符。
        </Message>
      )}
      <label>
        {reconnect ? "授权命令" : "PowerShell 连接并授权命令"}
        <textarea
          readOnly
          value={command}
          rows={reconnect ? 3 : 5}
          spellCheck={false}
        />
      </label>
      <button
        className="primary"
        disabled={!command}
        onClick={() =>
          void copy(command, reconnect ? "授权命令" : "连接并授权命令")
        }
      >
        {reconnect ? "复制授权命令" : "复制连接并授权命令"}
      </button>
      {!reconnect && (
        <details>
          <summary>手动配置服务器</summary>
          <p>
            如果不使用上面的命令，将下方配置保存到用户级{" "}
            <code>%USERPROFILE%\.codex\config.toml</code>，重启 Codex 后运行{" "}
            <code>{loginCommand}</code>。已有同名区块时替换原配置。
          </p>
          <label>
            Codex 服务器配置
            <textarea
              readOnly
              value={
                configuration ||
                (validName
                  ? "请先填写有效的远程地址。"
                  : "请先填写有效的连接名称。")
              }
              rows={7}
              spellCheck={false}
            />
          </label>
          <button
            className="secondary"
            disabled={!configuration}
            onClick={() => void copy(configuration, "服务器配置")}
          >
            复制服务器配置
          </button>
        </details>
      )}
      <Message>{feedback}</Message>
      <p>
        {reconnect
          ? "命令申请原连接的能力。"
          : "命令默认申请查询和本人草稿能力。"}
        最终授权范围以授权页勾选为准。
      </p>
    </section>
  );
}
