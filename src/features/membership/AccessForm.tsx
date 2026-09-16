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
  setupKey,
  token,
  onSuccess,
}: {
  mode: "setup" | "join" | "login";
  setupKey: string;
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
          { ...fields, token },
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
      ? "从一个团队开始。"
      : mode === "join"
        ? preview
          ? `加入${preview.team.name}`
          : "你收到一份团队邀请。"
        : "欢迎回来。";
  return (
    <div className="access-layout">
      <aside className="access-story">
        <Brand />
        <div className="story-content">
          <p className="eyebrow">让工作进展，有迹可循</p>
          <h2>
            写下今天，
            <br />
            一起向前。
          </h2>
          <p>
            连接团队的每一份工作记录，
            <br />
            让每一个人的进展被看见。
          </p>
          <div className="story-lines" aria-hidden="true">
            <span />
            <span />
            <span />
            <i />
          </div>
        </div>
        <span className="story-footer">日序 · 团队工作记录</span>
      </aside>
      <main className="access-main">
        <div className="access-card">
          <p className="eyebrow">
            {mode === "setup"
              ? "建立团队 / 01"
              : mode === "join"
                ? "团队邀请"
                : "成员登录"}
          </p>
          <h1>{title}</h1>
          <p className="subtitle">
            {mode === "setup"
              ? "创建你的账号，然后邀请同事加入。"
              : mode === "join"
                ? preview
                  ? `${preview.invitedBy} 邀请你一起记录工作。`
                  : "正在确认邀请…"
                : "登录你的账号，继续团队中的工作。"}
          </p>
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
              {mode === "setup" &&
                (setupKey ? (
                  <input type="hidden" name="setupKey" value={setupKey} />
                ) : (
                  <label>
                    引导密钥
                    <input name="setupKey" required autoComplete="off" />
                    <small>在本机启动日序的终端中获取首次创建链接。</small>
                  </label>
                ))}
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
              "还没有账号？请向团队成员获取邀请链接。"
            ) : (
              <a href="/login">已有账号？前往登录 →</a>
            )}
          </p>
        </div>
        <footer>每份记录都有归属，每次协作都更清楚。</footer>
      </main>
    </div>
  );
}
