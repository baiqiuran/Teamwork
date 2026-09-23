import { useState } from "react";

export function AiConnectionGuide({
  scopes,
  reconnect = false,
}: {
  scopes: string[];
  reconnect?: boolean;
}) {
  const name = "daily_flow";
  const loginCommand = `codex mcp login ${name} --scopes ${scopes.join(",")}`;
  const initialCommand = reconnect
    ? loginCommand
    : [
        `codex mcp add ${name} --url ${JSON.stringify(`${window.location.origin}/mcp`)} --oauth-client-id daily-flow-codex`,
        `if ($LASTEXITCODE -eq 0) { ${loginCommand} }`,
      ].join("\n");
  const [command, setCommand] = useState(initialCommand);
  const buttonLabel = reconnect ? "复制授权命令" : "复制连接并授权命令";
  const [copyLabel, setCopyLabel] = useState(buttonLabel);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyLabel("已复制");
    } catch {
      setCopyLabel("复制失败，请手动复制");
    }
  }

  return (
    <section
      className="ai-connection-guide"
      aria-label={reconnect ? "重新授权 Codex" : "连接 Codex 指引"}
    >
      <label>
        {reconnect ? "授权命令" : "PowerShell 连接并授权命令"}
        <textarea
          value={command}
          onChange={(event) => {
            setCommand(event.target.value);
            setCopyLabel(buttonLabel);
          }}
          rows={reconnect ? 3 : 5}
          spellCheck={false}
        />
      </label>
      <button
        className="primary"
        disabled={!command.trim()}
        onClick={() => void copy()}
      >
        {copyLabel}
      </button>
    </section>
  );
}
