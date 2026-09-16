import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { DiaryRecords } from "../../shared/components/DiaryRecords";
import { beijingToday } from "../../shared/time";
import { statusLabels } from "../../shared/status";
import type { Project, Task, PublishedDiary } from "../../shared/contracts";
type ShareType = "diary" | "project" | "task";
type Module = "overview" | "tasks" | "progress";
const moduleNames: Record<Module, string> = {
  overview: "概览",
  tasks: "任务列表",
  progress: "进展日报",
};
const typeNames: Record<ShareType, string> = {
  diary: "全团队日报",
  project: "项目",
  task: "任务",
};
interface Share {
  id: string;
  path: string;
  type: ShareType;
  targetName: string;
  from: string;
  to: string;
  modules: Module[];
  closed: boolean;
}
interface PublicData {
  type: ShareType;
  from: string;
  to: string;
  modules: Module[];
  overview?: {
    name: string;
    description: string;
    creator?: { name: string };
    diaryCount: number;
    entryCount: number;
    taskCount: number;
  };
  tasks?: Task[];
  progress?: PublishedDiary[];
}
export function Sharing() {
  const [shares, setShares] = useState<Share[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [type, setType] = useState<ShareType>("diary");
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [from, setFrom] = useState(beijingToday());
  const [to, setTo] = useState(beijingToday());
  const [modules, setModules] = useState<Module[]>([
    "overview",
    "tasks",
    "progress",
  ]);
  const [fresh, setFresh] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => setShares(await api("/shares"));
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setTaskId("");
    setTasks([]);
    if (projectId)
      api<Task[]>(`/projects/${projectId}/tasks`)
        .then(setTasks)
        .catch((e) => setError(e.message));
  }, [projectId]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-intro">
        <p className="eyebrow">公开分享</p>
        <h1>把需要的进展分享出去</h1>
        <p className="subtitle">
          持链接者可免登录查看所选范围。提交后的合法更新会自动同步。
        </p>
      </div>
      <form
        className="record-card definition-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const s = await api<Share>("/shares", {
              type,
              targetId:
                type === "project"
                  ? projectId
                  : type === "task"
                    ? taskId
                    : undefined,
              from,
              to,
              modules,
            });
            setFresh(s);
            await load();
          });
        }}
      >
        <label>
          分享内容
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ShareType)}
          >
            {Object.entries(typeNames).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {type !== "diary" && (
          <label>
            选择项目
            <select
              required
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">请选择项目</option>
              {projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {type === "task" && (
          <label>
            选择任务
            <select
              required
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">请选择任务</option>
              {tasks
                .filter((t) => !t.archived)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="filters">
          <label>
            开始日期
            <input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="module-choice">
          <legend>开放模块</legend>
          {Object.entries(moduleNames).map(([value, label]) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={modules.includes(value as Module)}
                onChange={(e) =>
                  setModules(
                    e.target.checked
                      ? [...modules, value as Module]
                      : modules.filter((m) => m !== value),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="field-hint">
          {type === "diary"
            ? "包含所选日期内所有成员的完整已提交日报，包括未关联项目的工作。"
            : "仅展示所选对象的相关进展，不会带出完整日报中的其他工作。"}
          任务模块显示当前状态，日期筛选进展。
        </p>
        <button className="primary" disabled={busy || !modules.length}>
          生成公开链接
        </button>
      </form>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="message">
          {notice}
        </p>
      )}
      {fresh && !fresh.closed && (
        <section className="fresh-invite">
          <label>
            新公开链接
            <input
              readOnly
              value={new URL(fresh.path, location.origin).href}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <a
            className="secondary"
            href={fresh.path}
            target="_blank"
            rel="noreferrer"
          >
            打开访客页
          </a>
          <button
            className="secondary"
            onClick={() =>
              action(async () => {
                try {
                  await navigator.clipboard.writeText(
                    new URL(fresh.path, location.origin).href,
                  );
                  setNotice("已复制公开链接。");
                } catch {
                  setNotice("请选择链接文字并手动复制。");
                }
              })
            }
          >
            复制链接
          </button>
        </section>
      )}
      <h2>我生成的链接</h2>
      {!shares.length && <p className="empty">还没有生成公开链接。</p>}
      {shares.map((s) => (
        <article className="share-row" key={s.id}>
          <div>
            <strong>{s.targetName}</strong>
            <p>
              {typeNames[s.type]} · {s.from} 至 {s.to}
            </p>
            <small>{s.modules.map((m) => moduleNames[m]).join(" / ")}</small>
          </div>
          <div className="inline-actions">
            {s.closed ? (
              <span className="muted">已关闭</span>
            ) : (
              <>
                <a href={s.path} target="_blank" rel="noreferrer">
                  查看公开页
                </a>
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api(`/shares/${s.id}/close`, {});
                      if (fresh?.id === s.id) setFresh(null);
                      await load();
                      setNotice("链接已关闭，原访问入口立即失效。");
                    })
                  }
                >
                  关闭链接
                </button>
              </>
            )}
          </div>
        </article>
      ))}
    </>
  );
}
export function PublicShare() {
  const token = window.location.pathname.split("/")[2];
  const [data, setData] = useState<PublicData | null>(null);
  const [active, setActive] = useState<Module>("overview");
  const [error, setError] = useState("");
  async function load() {
    try {
      const result = await api<PublicData>(
        `/public/${encodeURIComponent(token)}`,
      );
      setData(result);
      setActive((current) =>
        result.modules.includes(current) ? current : result.modules[0],
      );
      setError("");
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const refresh = () => {
      void load();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return (
    <main className="public-page">
      <header>
        <span className="brand">
          <span className="brand-mark">日</span>日序
        </span>
        <span className="private-label">公开只读</span>
      </header>
      {error ? (
        <section className="empty">
          <h1>链接暂不可访问</h1>
          <p role="alert">{error}</p>
          <button className="secondary" onClick={load}>
            重新加载
          </button>
        </section>
      ) : !data ? (
        <p role="status">正在读取公开内容…</p>
      ) : (
        <>
          <div className="journal-heading">
            <div>
              <p className="eyebrow">{typeNames[data.type]}分享</p>
              <h1>{data.overview?.name || `${typeNames[data.type]}进展`}</h1>
              <p className="subtitle">
                {data.from} 至 {data.to} · 北京时间
                {data.type === "diary" ? " · 全团队成员完整已提交内容" : ""}
              </p>
            </div>
            <button className="secondary" onClick={load}>
              刷新内容
            </button>
          </div>
          <nav className="module-tabs" aria-label="公开模块">
            {data.modules.map((m) => (
              <button
                key={m}
                className={active === m ? "selected" : ""}
                onClick={() => setActive(m)}
              >
                {moduleNames[m]}
              </button>
            ))}
          </nav>
          {active === "overview" && data.overview && (
            <section className="record-card">
              <p className="entry-body">{data.overview.description}</p>
              {data.overview.creator && (
                <p className="muted">{data.overview.creator.name} 创建</p>
              )}
              <div className="overview-counts">
                <div>
                  <strong>{data.overview.diaryCount}</strong>
                  <span>份进展日报</span>
                </div>
                <div>
                  <strong>{data.overview.entryCount}</strong>
                  <span>条工作</span>
                </div>
                <div>
                  <strong>{data.overview.taskCount}</strong>
                  <span>项任务</span>
                </div>
              </div>
            </section>
          )}
          {active === "tasks" && data.tasks && (
            <section>
              <p className="muted">当前任务状态 · 日期范围用于筛选进展日报</p>
              {!data.tasks.length && (
                <p className="empty">此范围内没有可展示的任务。</p>
              )}
              {data.tasks.map((t) => (
                <article className="record-card" key={t.id}>
                  <h2>
                    {t.name}{" "}
                    <span className="status">{statusLabels[t.status]}</span>
                  </h2>
                  <p className="muted">
                    {t.creator.name} 创建{t.archived ? " · 已归档" : ""}
                  </p>
                  <p className="entry-body">{t.description}</p>
                </article>
              ))}
            </section>
          )}
          {active === "progress" && data.progress && (
            <DiaryRecords
              records={data.progress}
              publicToken={token}
              layout="masonry"
            />
          )}
        </>
      )}
      <footer>日序 · 让每一天的进展清楚可见</footer>
    </main>
  );
}
