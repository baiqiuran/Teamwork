import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { DiaryRecords } from "../../shared/components/DiaryRecords";
import { statusLabels } from "../../shared/status";
import type {
  Project,
  Task,
  TaskEvent,
  PublishedDiary,
  TaskStatus,
} from "../../shared/contracts";
import "./Tasks.css";

function Chevron() {
  return (
    <svg
      className="task-chevron"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}
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
    const [detail, progress, history] = await Promise.all([
      api<Task>(`/tasks/${task.id}`),
      api<PublishedDiary[]>(`/tasks/${task.id}/progress`),
      api<TaskEvent[]>(`/tasks/${task.id}/events`),
    ]);
    setForm(null);
    setEditing(false);
    setSelected(detail);
    setRecords(progress);
    setEvents(history);
  }
  async function updateStatus(task: Task, status: TaskStatus) {
    if (status === task.status) return;
    await action(async () => {
      let updated: Task;
      try {
        updated = await api<Task>(`/tasks/${task.id}/status`, {
          status,
          expectedVersion: task.version,
        });
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 409) {
          await load();
          if (selected?.id === task.id) {
            setSelected(await api<Task>(`/tasks/${task.id}`));
            setEvents(await api<TaskEvent[]>(`/tasks/${task.id}/events`));
          }
          if (failure.details)
            throw new Error(
              "任务状态已被其他成员更新，已刷新最新状态，请重新选择。",
            );
        }
        throw failure;
      }
      setTasks((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (selected?.id === updated.id) {
        setSelected(updated);
        setEvents(await api<TaskEvent[]>(`/tasks/${updated.id}/events`));
      }
    });
  }
  return (
    <section className="tasks-panel" aria-busy={busy}>
      <div className="section-heading">
        <h2>
          任务列表 <span className="count">{tasks.length}</span>
        </h2>
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
      {busy && (
        <p className="task-feedback muted" role="status">
          正在处理…
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
        {tasks.map((task) => {
          const expanded = selected?.id === task.id;
          return (
            <section
              className={`task-item${expanded ? " task-item--expanded" : ""}`}
              key={task.id}
              aria-label={expanded ? "任务详情" : undefined}
            >
              <div className="task-item-header">
                <h3 className="task-item-heading" aria-label={task.name}>
                  <button
                    className="task-row task-disclosure"
                    disabled={busy}
                    aria-expanded={expanded}
                    aria-controls={
                      expanded ? `task-detail-${task.id}` : undefined
                    }
                    onClick={() => {
                      if (expanded) {
                        setSelected(null);
                        setForm(null);
                      } else void action(() => open(task));
                    }}
                  >
                    <strong className="task-name">{task.name}</strong>
                    <small className="task-creator">
                      {task.creator.name} 创建
                      {task.archived ? " · 已归档" : ""}
                    </small>
                    <span className="task-toggle">
                      <span>{expanded ? "收起详情" : "查看详情"}</span>
                      <Chevron />
                    </span>
                  </button>
                </h3>
                <select
                  className={`task-status task-status--${task.status}`}
                  aria-label={`${task.name} 的状态`}
                  value={task.status}
                  disabled={busy || task.archived || project.archived}
                  title={
                    project.archived
                      ? "项目已归档，恢复后可修改状态"
                      : task.archived
                        ? "任务已归档，恢复后可修改状态"
                        : "修改任务状态"
                  }
                  onChange={(event) =>
                    void updateStatus(task, event.target.value as TaskStatus)
                  }
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {expanded && selected && (
                <div
                  id={`task-detail-${task.id}`}
                  className="task-detail-content"
                >
                  {selected.description && (
                    <div className="task-description">
                      <h4 className="task-detail-label">原始说明</h4>
                      <p className="entry-body">{selected.description}</p>
                    </div>
                  )}
                  {selected.creator.id === memberId && (
                    <div className="task-detail-actions">
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setEditing(true);
                          setForm({
                            name: selected.name,
                            description: selected.description,
                          });
                        }}
                      >
                        编辑任务名称和说明
                      </button>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            if (
                              !window.confirm(
                                selected.archived
                                  ? "恢复任务？之前关闭的公开链接不会自动恢复。"
                                  : "归档任务并关闭此任务的专属公开链接？历史进展仍保留。",
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
                    </div>
                  )}
                  <details className="task-history">
                    <summary>
                      <Chevron />
                      状态变更记录{" "}
                      <span className="count">{events.length}</span>
                    </summary>
                    <div className="task-history-content">
                      {!events.length && (
                        <p className="muted">尚无状态变更。</p>
                      )}
                      {events.map((event) => (
                        <p className="muted" key={event.id}>
                          {event.member.name} ·{" "}
                          {new Date(event.at).toLocaleString("zh-CN", {
                            timeZone: "Asia/Shanghai",
                          })}{" "}
                          · {statusLabels[event.before]} →{" "}
                          {statusLabels[event.after]}
                          <small>
                            {event.kind === "direct"
                              ? "单独更新状态"
                              : "日报提交"}{" "}
                            / {event.channel === "mcp" ? "Codex" : "网页"}
                          </small>
                        </p>
                      ))}
                    </div>
                  </details>
                  <div className="task-progress">
                    <h4 className="task-detail-label">任务进展</h4>
                    {records.length ? (
                      <DiaryRecords records={records} />
                    ) : (
                      <p className="muted task-progress-empty">
                        暂无进展，可在日报中关联此任务并提交。
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
