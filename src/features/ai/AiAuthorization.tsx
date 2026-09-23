import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
const permissions: Record<string, { label: string; description: string }> = {
  "progress:read": {
    label: "查询团队工作进展",
    description: "查看本团队项目、任务和已提交的进展。",
  },
  "drafts:write": {
    label: "读写本人日报草稿",
    description: "读取和保存你的草稿，不会直接公开。",
  },
  "diaries:submit": {
    label: "提交本人日报",
    description: "提交后会更新团队阅读内容和已有公开页。",
  },
  "tasks:write": {
    label: "创建任务和更新任务状态",
    description: "更新状态可能改变公开任务列表。",
  },
  "shares:manage": {
    label: "创建和关闭本人公开链接",
    description: "日报链接可展示所选日期内全团队已提交的内容。",
  },
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
    <main className="content oauth-consent-page">
      <section className="account-card oauth-consent-card">
        <h1>授权 Codex</h1>
        <p className="oauth-consent-intro">
          选择 Codex 可以代表你执行的操作。授权持续到你撤销连接。
        </p>
        <Message error>{error}</Message>
        {details && (
          <>
            <fieldset className="oauth-scopes" disabled={busy}>
              <legend>授权能力</legend>
              {details.scopes.map((scope) => {
                const permission = permissions[scope] ?? {
                  label: scope,
                  description: "",
                };
                const descriptionId = `oauth-${scope.replaceAll(":", "-")}`;
                return (
                  <label className="oauth-scope" key={scope}>
                    <input
                      type="checkbox"
                      aria-label={permission.label}
                      aria-describedby={
                        permission.description ? descriptionId : undefined
                      }
                      checked={scopes.includes(scope)}
                      onChange={(e) =>
                        setScopes((current) =>
                          e.target.checked
                            ? [...current, scope]
                            : current.filter((s) => s !== scope),
                        )
                      }
                    />
                    <span>
                      <strong>{permission.label}</strong>
                      {permission.description && (
                        <small id={descriptionId}>
                          {permission.description}
                        </small>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="oauth-consent-note">
              操作仍受团队权限、日报日期和版本冲突规则约束。
            </p>
            <div className="oauth-consent-actions">
              <button
                className="primary"
                disabled={busy || !scopes.length}
                onClick={() => void decide(true)}
              >
                允许所选能力
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                取消授权
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
