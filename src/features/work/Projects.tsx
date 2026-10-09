import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { DiaryRecords } from "../../shared/components/DiaryRecords";
import { beijingToday } from "../../shared/time";
import type { Project, PublishedDiary } from "../../shared/contracts";
import { Tasks } from "./Tasks";
export function Projects({ memberId }: { memberId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [records, setRecords] = useState<PublishedDiary[]>([]);
  const progressQuery = useRef(0);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [form, setForm] = useState<{
    name: string;
    description: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(beijingToday());
  const [to, setTo] = useState(beijingToday());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => setProjects(await api("/projects"));
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const projectId = new URLSearchParams(window.location.search).get(
      "project",
    );
    if (projectId)
      api<Project>(`/projects/${encodeURIComponent(projectId)}`)
        .then((project) => {
          if (progressQuery.current === 0) return open(project);
        })
        .catch((e) => setError(e.message));
    return () => {
      progressQuery.current++;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(p: Project) {
    const query = ++progressQuery.current;
    setSelected(p);
    setForm(null);
    setRecords([]);
    setProgressError("");
    setProgressLoading(true);
    try {
      const result = await api<PublishedDiary[]>(
        `/projects/${p.id}/progress?from=${from}&to=${to}`,
      );
      if (query === progressQuery.current) setRecords(result);
    } catch (error) {
      if (query === progressQuery.current)
        setProgressError((error as Error).message);
    } finally {
      if (query === progressQuery.current) setProgressLoading(false);
    }
  }
  return (
    <>
      <div className="journal-heading">
        <div>
          <h1>项目与任务</h1>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setForm({ name: "", description: "" });
          }}
        >
          ＋ 新建项目
        </button>
      </div>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {form && (
        <form
          className="record-card definition-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const p = await api<Project>(
                editing ? `/projects/${selected!.id}/save` : "/projects",
                form,
              );
              await refresh();
              await open(p);
            });
          }}
        >
          <h2>{editing ? "编辑项目资料" : "新建项目"}</h2>
          <label>
            项目名称
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            项目说明
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <div className="inline-actions">
            <button className="primary" disabled={busy}>
              保存项目
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setForm(null)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="projects-workbench">
        <aside className="project-rail" aria-label="项目列表">
          <div className="project-rail-heading">
            <h2>项目</h2>
            <span className="count">{projects.length}</span>
          </div>
          <div className="project-picker">
            {projects.map((p) => (
              <button
                key={p.id}
                className={selected?.id === p.id ? "selected" : ""}
                aria-current={selected?.id === p.id ? "true" : undefined}
                onClick={() => void open(p)}
              >
                <strong>{p.name}</strong>
                <small>
                  {p.creator.name} 创建{p.archived ? " · 已归档" : ""}
                </small>
              </button>
            ))}
          </div>
          {!projects.length && <p className="muted">暂无项目。</p>}
        </aside>
        <div className="project-main">
          {selected ? (
            <>
              <section className="record-card project-overview">
                <div className="section-heading">
                  <div>
                    <h2>{selected.name}</h2>
                    <p className="muted">{selected.creator.name} 创建</p>
                  </div>
                  {selected.creator.id === memberId && (
                    <button
                      className="secondary"
                      onClick={() => {
                        setEditing(true);
                        setForm({
                          name: selected.name,
                          description: selected.description,
                        });
                      }}
                    >
                      编辑项目资料
                    </button>
                  )}
                </div>
                <p className="entry-body">
                  {selected.description || "暂无项目说明"}
                </p>
                {selected.archived && (
                  <p className="message">
                    项目已归档，保留历史，停止新增进展。恢复后旧公开链接仍保持关闭。
                  </p>
                )}
                {selected.creator.id === memberId && (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        if (
                          !window.confirm(
                            selected.archived
                              ? "恢复项目？之前关闭的公开链接不会自动恢复。"
                              : "归档项目并关闭此项目及其任务的专属公开链接？团队日报中的历史条目仍保留。",
                          )
                        )
                          return;
                        const updated = await api<Project>(
                          `/projects/${selected.id}/archive`,
                          { archived: !selected.archived },
                        );
                        await refresh();
                        await open(updated);
                      })
                    }
                  >
                    {selected.archived ? "恢复项目" : "归档项目"}
                  </button>
                )}
              </section>
              <div className="project-section">
                <Tasks
                  key={selected.id}
                  project={selected}
                  memberId={memberId}
                />
              </div>
              <section className="project-section project-progress">
                <h2>工作进展</h2>
                <form
                  className="filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void open(selected);
                  }}
                >
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
                  <button className="secondary" disabled={busy}>
                    查看进展
                  </button>
                </form>
                {progressLoading ? (
                  <p role="status" className="muted">
                    正在加载项目进展…
                  </p>
                ) : progressError ? (
                  <p role="alert" className="message error">
                    {progressError} 请重试查看进展。
                  </p>
                ) : (
                  <DiaryRecords records={records} layout="masonry" />
                )}
              </section>
            </>
          ) : (
            <div className="empty">
              {projects.length
                ? "选择左侧项目查看任务和进展。"
                : "新建项目后，可在日报中关联工作。"}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
