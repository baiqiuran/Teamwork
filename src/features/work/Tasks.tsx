import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { DiaryRecords } from "../../shared/components/DiaryRecords";
import { statusLabels } from "../../shared/status";
import type {
  Project,
  Task,
  TaskEvent,
  PublishedDiary,
} from "../../shared/contracts";
export function Tasks({
  project,
  memberId,
}: {
  project: Project;
  memberId: string;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [records, setRecords] = useState<PublishedDiary[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [form, setForm] = useState<{
    name: string;
    description: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => setTasks(await api(`/projects/${project.id}/tasks`));
  useEffect(() => {
    setSelected(null);
    setForm(null);
    load().catch((e) => setError(e.message));
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (taskId)
      api<Task>(`/tasks/${encodeURIComponent(taskId)}`)
        .then((task) => {
          if (task.projectId === project.id) return open(task);
        })
        .catch((e) => setError(e.message));
  }, [project.id]);
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
  async function open(task: Task) {
    setForm(null);
    setEditing(false);
    setSelected(await api(`/tasks/${task.id}`));
    setRecords(await api(`/tasks/${task.id}/progress`));
    setEvents(await api(`/tasks/${task.id}/events`));
  }
  return (
    <section>
      <div className="section-heading">
        <h2>任务列表</h2>
        <button
          className="secondary"
          disabled={busy || project.archived}
          onClick={() => {
            setEditing(false);
            setForm({ name: "", description: "" });
          }}
        >
          ＋ 新建任务
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
              const task = await api<Task>(
                editing
                  ? `/tasks/${selected!.id}/save`
                  : `/projects/${project.id}/tasks`,
                form,
              );
              setForm(null);
              await load();
              await open(task);
            });
          }}
        >
          <label>
            任务名称
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            任务原始说明
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
          <div className="inline-actions">
            <button className="primary" disabled={busy}>
              保存任务
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
      <div className="task-list">
        {!tasks.length && (
          <p className="muted">暂无任务，可先记录项目临时工作。</p>
        )}
        {tasks.map((t) => (
          <button
            className="task-row"
            key={t.id}
            onClick={() => action(() => open(t))}
          >
            <strong>{t.name}</strong>
            <span>
              {statusLabels[t.status]}
              {t.archived ? " · 已归档" : ""}
            </span>
            <small>{t.creator.name} 创建</small>
          </button>
        ))}
      </div>
      {selected && (
        <section className="record-card task-detail" aria-label="任务详情">
          <div className="section-heading">
            <h2>{selected.name}</h2>
            <button className="text-button" onClick={() => setSelected(null)}>
              收起详情
            </button>
          </div>
          <p>
            当前任务状态：<strong>{statusLabels[selected.status]}</strong>
          </p>
          <p className="muted">{selected.creator.name} 创建</p>
          <h3>原始说明</h3>
          <p className="entry-body">{selected.description || "暂无说明"}</p>
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
              编辑任务定义
            </button>
          )}
          <div>
            {selected.creator.id === memberId && (
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    if (
                      !window.confirm(
                        selected.archived
                          ? "恢复任务？旧公开链接不会自动重开。"
                          : "归档任务并关闭此任务的专属链接？历史进展继续保留。",
                      )
                    )
                      return;
                    const updated = await api<Task>(
                      `/tasks/${selected.id}/archive`,
                      { archived: !selected.archived },
                    );
                    await load();
                    await open(updated);
                  })
                }
              >
                {selected.archived ? "恢复任务" : "归档任务"}
              </button>
            )}
          </div>
          <h3>状态变更记录</h3>
          {!events.length && <p className="muted">尚无状态变更。</p>}
          {events.map((e) => (
            <p className="muted" key={e.id}>
              {e.member.name} ·{" "}
              {new Date(e.at).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}{" "}
              · {statusLabels[e.before]} → {statusLabels[e.after]}
              <small>
                {" "}
                · {e.kind === "direct" ? "独立变更" : "日报提交"} /{" "}
                {e.channel === "mcp" ? "Codex" : "网页"}
              </small>
            </p>
          ))}
          <h3>成员进展</h3>
          <p className="muted">在我的日报中关联此任务，即可补充进展。</p>
          <DiaryRecords records={records} />
        </section>
      )}
    </section>
  );
}
