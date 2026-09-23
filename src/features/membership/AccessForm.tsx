import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../shared/api";
import type { Identity } from "../../shared/contracts";
import { Brand } from "../../shared/components/Brand";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
export function AccessForm({
  mode,
  token,
  onSuccess,
}: {
  mode: "setup" | "join" | "login";
  token: string;
  onSuccess: (identity: Identity) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    team: { name: string };
    invitedBy: string;
  } | null>(null);
  const [inviteError, setInviteError] = useState("");
  useEffect(() => {
    if (mode !== "join") return;
    let active = true;
    api<{ team: { name: string }; invitedBy: string }>("/invitations/preview", {
      token,
    })
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error) => {
        if (active) setInviteError(describeError(error));
      });
    return () => {
      active = false;
    };
  }, [mode, token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      onSuccess(
        await api<Identity>(
          mode === "setup" ? "/setup" : mode === "join" ? "/join" : "/login",
          mode === "join" ? { ...fields, token } : fields,
        ),
      );
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "setup"
      ? "创建团队"
      : mode === "join"
        ? preview
          ? `加入${preview.team.name}`
          : "加入团队"
        : "登录";
  return (
    <div className="access-layout">
      <aside className="access-story">
        <Brand />
        <div className="story-content">
          <h2>团队日报与项目进展</h2>
          <p>在日报中记录工作，提交后供团队查看。</p>
        </div>
      </aside>
      <main className="access-main">
        <div className="access-card">
          <h1>{title}</h1>
          {mode !== "login" && (
            <p className="subtitle">
              {mode === "setup"
                ? "创建后可邀请成员加入。"
                : preview
                  ? `${preview.invitedBy} 邀请你加入此团队。`
                  : "正在确认邀请…"}
            </p>
          )}
          <Message error>{inviteError}</Message>
          {!inviteError && (mode !== "join" || preview) && (
            <form onSubmit={submit}>
              {mode === "setup" && (
                <label>
                  团队名称
                  <input
                    name="teamName"
                    autoComplete="organization"
                    required
                    maxLength={60}
                    placeholder="例如：设计工作室"
                  />
                </label>
              )}
              {mode !== "login" && (
                <label>
                  姓名
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={60}
                    placeholder="同事认识你的名字"
                  />
                </label>
              )}
              <label>
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                />
              </label>
              <label>
                密码
                <input
                  aria-label="密码"
                  aria-describedby={
                    mode === "login" ? undefined : "password-help"
                  }
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder={mode === "login" ? "输入密码" : "至少 12 个字符"}
                />
                {mode !== "login" && (
                  <small id="password-help">
                    使用至少 12 个字符，可包含字母、数字和符号。
                  </small>
                )}
              </label>
              <Message error>{error}</Message>
              <button className="primary full" disabled={busy}>
                {busy
                  ? "请稍候…"
                  : mode === "setup"
                    ? "创建团队并进入"
                    : mode === "join"
                      ? "加入团队"
                      : "登录"}
                {!busy && <Arrow />}
              </button>
            </form>
          )}
          <p className="access-note">
            {mode === "login" ? (
              <>
                <a href="/setup">创建新团队 →</a>
                <br />
                加入已有团队需获取成员发出的邀请链接。
              </>
            ) : (
              <a href="/login">已有账号？前往登录 →</a>
            )}
          </p>
        </div>
        <footer>每个账号只属于一个团队，邮箱不能重复注册。</footer>
      </main>
    </div>
  );
}
