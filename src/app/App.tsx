import { useEffect, useState } from "react";
import { api, ApiError } from "../shared/api";
import type { Identity } from "../shared/contracts";
import { Brand } from "../shared/components/Brand";
import { Icon } from "../shared/components/Icons";
import { Message } from "../shared/components/Message";
import { describeError } from "../shared/errors";
import { AccessForm } from "../features/membership/AccessForm";
import { Invitations } from "../features/membership/Invitations";
import { Members } from "../features/membership/Members";
import { AiAuthorization } from "../features/ai/AiAuthorization";
import { AiConnections } from "../features/ai/AiConnections";
import { Diaries } from "../features/diaries/Diaries";
import { TeamDiaries } from "../features/diaries/TeamDiaries";
import { Projects } from "../features/work/Projects";
import { Sharing } from "../features/sharing/Sharing";
type Tab =
  | "diaries"
  | "team"
  | "projects"
  | "sharing"
  | "members"
  | "invitations"
  | "account"
  | "ai";
const tabByPath = {
  "/members": "members",
  "/invitations": "invitations",
  "/team": "team",
  "/projects": "projects",
  "/sharing": "sharing",
  "/account": "account",
  "/ai": "ai",
} as const;
function Workspace({
  identity,
  onLogout,
}: {
  identity: Identity;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>(
    () =>
      tabByPath[window.location.pathname as keyof typeof tabByPath] ??
      "diaries",
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
          <Icon name="workspace" />
          <div>
            {identity.team.name}
            <small>团队工作空间</small>
          </div>
        </div>
        <p className="nav-caption">工作空间</p>
        <nav aria-label="团队导航">
          {(
            [
              ["diaries", "我的日报", "diary"],
              ["team", "团队日报", "team"],
              ["projects", "项目与任务", "tasks"],
              ["sharing", "公开分享", "share"],
              ["members", "团队成员", "roster"],
              ["invitations", "成员邀请", "invite"],
              ["account", "我的账号", "account"],
              ["ai", "AI 连接", "ai"],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              className={tab === key ? "selected" : ""}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => {
                window.history.replaceState({}, "", `/${key}`);
                setTab(key);
              }}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
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
              {
                {
                  diaries: "我的日报",
                  team: "团队日报",
                  projects: "项目与任务",
                  sharing: "公开分享",
                  members: "团队成员",
                  invitations: "成员邀请",
                  account: "我的账号",
                  ai: "AI 连接",
                }[tab]
              }
            </strong>
          </span>
          <span className="private-label">
            <Icon name="lock" /> 团队内部
          </span>
        </header>
        <main className={`content${tab === "team" ? " content--team" : ""}`}>
          <div hidden={tab !== "diaries"}>
            <Diaries />
          </div>
          {tab === "ai" ? (
            <AiConnections />
          ) : tab === "sharing" ? (
            <Sharing />
          ) : tab === "projects" ? (
            <Projects memberId={identity.member.id} />
          ) : tab === "team" ? (
            <TeamDiaries />
          ) : tab === "diaries" ? null : tab === "members" ? (
            <Members />
          ) : tab === "invitations" ? (
            <Invitations onExpired={onLogout} />
          ) : (
            <>
              <div className="page-intro">
                <p className="eyebrow">账号信息</p>
                <h1>我的账号</h1>
                <p className="subtitle">
                  查看姓名、邮箱和所属团队，或退出登录。
                </p>
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

export function App() {
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
    if (entry.path !== "/ai/authorize")
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
        <Message error={!!error}>{error || "正在加载…"}</Message>
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
  if (identity)
    return entry.path === "/ai/authorize" ? (
      <AiAuthorization />
    ) : (
      <Workspace identity={identity} onLogout={logout} />
    );
  const mode =
    entry.path === "/join"
      ? "join"
      : entry.path === "/setup" || (entry.path === "/" && needsSetup)
        ? "setup"
        : "login";
  return (
    <AccessForm
      mode={mode}
      token={entry.params.get("invite") ?? ""}
      onSuccess={enter}
    />
  );
}
