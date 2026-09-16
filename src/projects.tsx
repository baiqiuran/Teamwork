import { useEffect, useState } from "react";
import { api } from "./api";
import { Tasks } from "./tasks";
import { beijingToday, DiaryRecords, type PublishedDiary } from "./reading";
export interface Project {
  id: string;
  name: string;
  description: string;
  creator: { id: string; name: string };
  archived: boolean;
}
export function Projects({ memberId }: { memberId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [records, setRecords] = useState<PublishedDiary[]>([]);
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
    setSelected(p);
    setForm(null);
    setRecords(await api(`/projects/${p.id}/progress?from=${from}&to=${to}`));
  }
  return (
    <>
      <div className="journal-heading">
        <div>
          <p className="eyebrow">项目与任务</p>
          <h1>按项目看进展</h1>
          <p className="subtitle">项目汇集关联工作，完整日报仍保留在日报页。</p>
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
      <div className="project-picker">
        {projects.map((p) => (
          <button
            key={p.id}
            className={selected?.id === p.id ? "selected" : ""}
            onClick={() => action(() => open(p))}
          >
            <strong>{p.name}</strong>
            <small>
              {p.creator.name} 创建{p.archived ? " · 已归档" : ""}
            </small>
          </button>
        ))}
      </div>
      {!projects.length && (
        <div className="empty">创建第一个项目，即可在工作条目中 @ 关联。</div>
      )}
      {selected && (
        <>
          <section className="record-card">
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
                          ? "恢复项目？旧公开链接不会自动重开。"
                          : "归档项目并关闭其项目、任务专属链接？全团队日报中的历史条目仍保留。",
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
          <Tasks key={selected.id} project={selected} memberId={memberId} />
          <h2>工作进展</h2>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              void action(() => open(selected));
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
          <DiaryRecords records={records} />
        </>
      )}
    </>
  );
}
