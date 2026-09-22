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
        <p className="eyebrow">AI 连接授权</p>
        <h1>允许 Codex 为你处理工作</h1>
        <p>选择 Codex 可使用的能力。授权持续有效，直到你在 AI 连接中撤销。</p>
        <p>
          勾选提交、任务或公开分享后，Codex
          可自动执行这些操作。提交会更新已有公开页；独立更新任务状态也会改变已开放任务模块的当前状态；日报公开链接会包含所选日期的全团队已提交内容。
        </p>
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
