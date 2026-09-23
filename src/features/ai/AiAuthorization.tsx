import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
const labels: Record<string, string> = {
  "progress:read": "查询团队工作进展",
  "drafts:write": "读写本人日报草稿",
  "diaries:submit": "提交本人日报",
  "tasks:write": "创建任务和更新任务状态",
  "shares:manage": "创建和关闭本人公开链接",
};
export function AiAuthorization() {
  const [details, setDetails] = useState<{
    request: Record<string, string>;
    scopes: string[];
  }>();
  const [scopes, setScopes] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ request: Record<string, string>; scopes: string[] }>(
      `/ai/authorize${window.location.search}`,
    )
      .then((value) => {
        setDetails(value);
        setScopes(
          value.scopes.filter((s) =>
            ["progress:read", "drafts:write"].includes(s),
          ),
        );
      })
      .catch((e) => setError(describeError(e)));
  }, []);
  async function decide(approve: boolean) {
    if (!details) return;
    setBusy(true);
    try {
      const result = await api<{ redirect: string }>("/ai/authorize", {
        request: details.request,
        scopes,
        approve,
      });
      window.location.assign(result.redirect);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }
  return (
    <main className="content">
      <section className="account-card">
        <h1>授权 Codex</h1>
        <p>选择允许的操作。授权持续到你撤销连接。</p>
        <ul className="permission-notes">
          <li>提交日报会更新团队阅读内容和已有公开页。</li>
          <li>更新任务状态会改变公开任务列表中的当前状态。</li>
          <li>日报公开链接会展示所选日期内全团队的已提交内容。</li>
        </ul>
        <Message error>{error}</Message>
        {details && (
          <>
            <fieldset disabled={busy}>
              <legend>授权能力</legend>
              {details.scopes.map((scope) => (
                <label
                  key={scope}
                  style={{ display: "flex", gap: 12, marginBlock: 16 }}
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((current) =>
                        e.target.checked
                          ? [...current, scope]
                          : current.filter((s) => s !== scope),
                      )
                    }
                  />
                  {labels[scope]}
                </label>
              ))}
            </fieldset>
            <p>你的操作仍受团队权限、日报日期和版本冲突规则约束。</p>
            <button
              className="primary"
              disabled={busy || !scopes.length}
              onClick={() => void decide(true)}
            >
              允许所选能力
            </button>{" "}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              取消授权
            </button>
          </>
        )}
      </section>
    </main>
  );
}
