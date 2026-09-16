import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, type Identity, type Invitation } from "./api";
import "./style.css";
import { Diaries } from "./diaries";

function Brand() {
  return (
    <a className="brand" href="/" aria-label="日序首页">
      <span className="brand-mark" aria-hidden="true">
        日
      </span>
      <span>
        日序<small>每一天，都有进展。</small>
      </span>
    </a>
  );
}
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return children ? (
    <p
      className={error ? "message error" : "message"}
      role={error ? "alert" : "status"}
    >
      {children}
    </p>
  ) : null;
}
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
const formatDate = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
    hour12: false,
  }).format(time);

function AccessForm({
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

function Invitations({ onExpired }: { onExpired: () => void }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      onExpired();
      return;
    }
    setError(describeError(error));
  }
  async function load() {
    const result = await api<{ invitations: Invitation[] }>("/invitations");
    setInvitations(result.invitations);
    setFresh((current) =>
      current &&
      result.invitations.some(
        (item) => item.id === current.id && item.status === "active",
      )
        ? current
        : null,
    );
  }
  useEffect(() => {
    load()
      .catch(fail)
      .finally(() => setLoading(false));
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    const result = await api<{ invitation: { id: string }; joinPath: string }>(
      "/invitations",
      {},
    );
    setFresh({
      id: result.invitation.id,
      url: new URL(result.joinPath, window.location.origin).href,
    });
    await load();
    setNotice("邀请已生成。请复制链接，发送给一位同事。");
  }
  const labels = {
    active: "待接受",
    used: "已接受",
    revoked: "已撤销",
    expired: "已过期",
  };
  return (
    <>
      <div className="page-intro">
        <p className="eyebrow">成员邀请</p>
        <h1>邀请同事，一起开始。</h1>
        <p className="subtitle">每位成员都可以邀请同事加入，协作从这里开始。</p>
      </div>
      <section className="invite-panel" aria-labelledby="new-invite-title">
        <div className="invite-main">
          <span className="section-index">01 / 发出邀请</span>
          <h2 id="new-invite-title">给同事一个加入入口</h2>
          <p>生成专属邀请链接，复制后发送给同事。</p>
          <button
            className="primary"
            onClick={() => perform(create)}
            disabled={busy || loading}
          >
            {busy ? "处理中…" : "生成邀请链接"}
            <Arrow />
          </button>
        </div>
        <div className="invite-notes">
          <span className="note-symbol" aria-hidden="true">
            ↗
          </span>
          <h3>一份邀请，一位新伙伴。</h3>
          <ul>
            <li>链接在 7 天内有效</li>
            <li>成功加入后，链接自动失效</li>
            <li>接受前，你可以随时撤销</li>
          </ul>
        </div>
      </section>
      <Message error>{error}</Message>
      <Message>{notice}</Message>
      {fresh && (
        <section className="fresh-invite">
          <label>
            新邀请链接
            <input
              value={fresh.url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button
            className="secondary"
            onClick={() =>
              perform(async () => {
                try {
                  await navigator.clipboard.writeText(fresh.url);
                  setNotice("已复制，可以发送给同事了。");
                } catch {
                  setNotice("请选择链接文字并手动复制。");
                }
              })
            }
            disabled={busy}
          >
            复制链接
          </button>
          <small>请现在保存链接；离开页面后如需再次邀请，可生成新链接。</small>
        </section>
      )}
      <section className="history" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <h2 id="history-title">
              我发出的邀请 <span className="count">{invitations.length}</span>
            </h2>
            <p>仅展示你生成的邀请。</p>
          </div>
          <button
            className="text-button"
            disabled={busy || loading}
            onClick={() => perform(load)}
          >
            刷新列表 ↻
          </button>
        </div>
        {loading ? (
          <p role="status" className="empty">
            正在读取邀请…
          </p>
        ) : invitations.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              ＋
            </div>
            <h3>第一位同事，等你邀请。</h3>
            <p>生成链接后，可以在这里查看状态或撤销邀请。</p>
          </div>
        ) : (
          <div className="invitation-list">
            {invitations.map((invitation) => (
              <article className="invitation-row" key={invitation.id}>
                <span className="invite-avatar" aria-hidden="true">
                  ↗
                </span>
                <div className="invitation-detail">
                  <h3>邀请 {invitation.id.slice(0, 6).toUpperCase()}</h3>
                  <p>
                    {formatDate(invitation.createdAt)} 发出{" "}
                    <span>· {formatDate(invitation.expiresAt)} 到期</span>
                  </p>
                </div>
                <span className={`status ${invitation.status}`}>
                  {labels[invitation.status]}
                </span>
                <div className="row-action">
                  {invitation.status === "active" && (
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await api(`/invitations/${invitation.id}/revoke`, {});
                          await load();
                          setNotice("邀请已撤销，原链接不能再加入团队。");
                        })
                      }
                    >
                      撤销
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="page-footnote">邀请时间以北京时间显示。</p>
    </>
  );
}

function Workspace({
  identity,
  onLogout,
}: {
  identity: Identity;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<"diaries" | "invitations" | "account">(
    window.location.pathname === "/members" ? "invitations" : "diaries",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await api("/logout", {});
      onLogout();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="team-badge">
          <span aria-hidden="true">◈</span>
          <div>
            {identity.team.name}
            <small>团队工作空间</small>
          </div>
        </div>
        <p className="nav-caption">工作空间</p>
        <nav aria-label="团队导航">
          <button
            className={tab === "diaries" ? "selected" : ""}
            onClick={() => {
              window.location.assign("/diaries");
            }}
          >
            我的日报
          </button>
          <button
            className={tab === "invitations" ? "selected" : ""}
            aria-current={tab === "invitations" ? "page" : undefined}
            onClick={() => setTab("invitations")}
          >
            <span aria-hidden="true">↗</span>成员邀请
          </button>
          <button
            className={tab === "account" ? "selected" : ""}
            aria-current={tab === "account" ? "page" : undefined}
            onClick={() => setTab("account")}
          >
            <span aria-hidden="true">◎</span>我的账号
          </button>
        </nav>
        <div className="sidebar-member">
          <span className="member-avatar" aria-hidden="true">
            {identity.member.name.slice(0, 1)}
          </span>
          <div>
            <strong>{identity.member.name}</strong>
            <small>团队成员</small>
          </div>
          <span className="online-dot" aria-label="已登录" />
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <span>
            工作空间 <span className="breadcrumb-divider">/</span>{" "}
            <strong>
              {tab === "diaries"
                ? "我的日报"
                : tab === "invitations"
                  ? "成员邀请"
                  : "我的账号"}
            </strong>
          </span>
          <span className="private-label">
            <span aria-hidden="true">◈</span> 团队内部
          </span>
        </header>
        <main className="content">
          <div hidden={tab !== "diaries"}>
            <Diaries />
          </div>
          {tab === "diaries" ? null : tab === "invitations" ? (
            <Invitations onExpired={onLogout} />
          ) : (
            <>
              <div className="page-intro">
                <p className="eyebrow">我的账号</p>
                <h1>你的团队身份。</h1>
                <p className="subtitle">你的工作记录和操作将归属于这个账号。</p>
              </div>
              <section className="account-card">
                <dl>
                  <div>
                    <dt>姓名</dt>
                    <dd>{identity.member.name}</dd>
                  </div>
                  <div>
                    <dt>邮箱</dt>
                    <dd>{identity.member.email}</dd>
                  </div>
                  <div>
                    <dt>所属团队</dt>
                    <dd>{identity.team.name}</dd>
                  </div>
                </dl>
                <Message error>{error}</Message>
                <button className="secondary" onClick={logout} disabled={busy}>
                  {busy ? "正在退出…" : "退出登录"}
                </button>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState("");
  const [entry] = useState(() => ({
    path: window.location.pathname,
    params: new URLSearchParams(window.location.hash.slice(1)),
  }));
  useEffect(() => {
    async function initialize() {
      try {
        setIdentity(await api<Identity>("/me"));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        setNeedsSetup(
          (await api<{ needsSetup: boolean }>("/setup/status")).needsSetup,
        );
      }
    }
    initialize()
      .catch((error) => setError(describeError(error)))
      .finally(() => setLoading(false));
  }, []);
  function enter(identity: Identity) {
    window.history.replaceState({}, "", "/members");
    setIdentity(identity);
    setNeedsSetup(false);
  }
  function logout() {
    window.location.assign("/login");
  }
  if (loading || error)
    return (
      <main className="loading-screen">
        <Brand />
        <Message error={!!error}>{error || "正在打开你的工作空间…"}</Message>
        {error && (
          <button
            className="secondary"
            onClick={() => window.location.reload()}
          >
            重新连接
          </button>
        )}
      </main>
    );
  if (identity) return <Workspace identity={identity} onLogout={logout} />;
  const mode = entry.path === "/join" ? "join" : needsSetup ? "setup" : "login";
  return (
    <AccessForm
      mode={mode}
      token={entry.params.get("invite") ?? ""}
      setupKey={entry.params.get("key") ?? ""}
      onSuccess={enter}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
