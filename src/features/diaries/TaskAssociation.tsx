import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { statusLabels } from "../../shared/status";
import type { Entry, Task, TaskStatus } from "../../shared/contracts";
export function TaskAssociation({
  entry,
  index,
  onChange,
}: {
  entry: Entry;
  index: number;
  onChange: (entry: Entry) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setTasks([]);
    if (entry.projectId)
      api<Task[]>(`/projects/${entry.projectId}/tasks`)
        .then(setTasks)
        .catch((e) => setError(e.message));
  }, [entry.projectId]);
  if (!entry.projectId) return null;
  return (
    <details className="task-association">
      <summary>
        {entry.taskId
          ? `任务：${tasks.find((t) => t.id === entry.taskId)?.name || entry.taskName || "已关联"}`
          : entry.newTask
            ? `新任务：${entry.newTask.name || "待填写"}`
            : "关联任务或更新状态（选填）"}
        {entry.statusChange &&
          ` · 提交时${statusLabels[entry.statusChange.status]}`}
      </summary>
      {error && <p role="alert">{error}</p>}
      <label>
        任务
        <select
          aria-label={`工作 ${index + 1} 任务`}
          value={entry.newTask ? "__new" : entry.taskId || ""}
          onChange={(e) =>
            onChange({
              ...entry,
              taskId:
                e.target.value && e.target.value !== "__new"
                  ? e.target.value
                  : undefined,
              taskName: undefined,
              taskStatus: undefined,
              newTask:
                e.target.value === "__new"
                  ? { name: "", description: "" }
                  : undefined,
              statusChange: undefined,
            })
          }
        >
          <option value="">临时工作，不关联任务</option>
          {tasks
            .filter((t) => !t.archived || t.id === entry.taskId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {statusLabels[t.status]} · {t.creator.name} 创建
                {t.archived ? "（已归档）" : ""}
              </option>
            ))}
          <option value="__new">＋ 新建任务，随日报提交创建</option>
        </select>
      </label>
      {entry.newTask && (
        <>
          <label>
            新任务名称
            <input
              aria-label={`工作 ${index + 1} 新任务名称`}
              maxLength={100}
              value={entry.newTask.name}
              onChange={(e) =>
                onChange({
                  ...entry,
                  newTask: { ...entry.newTask!, name: e.target.value },
                })
              }
            />
          </label>
          <label>
            原始说明
            <textarea
              aria-label={`工作 ${index + 1} 新任务说明`}
              value={entry.newTask.description}
              onChange={(e) =>
                onChange({
                  ...entry,
                  newTask: { ...entry.newTask!, description: e.target.value },
                })
              }
            />
          </label>
        </>
      )}
      {(entry.taskId || entry.newTask) && (
        <label>
          提交时更新状态
          <select
            aria-label={`工作 ${index + 1} 更新状态`}
            value={entry.statusChange?.status || ""}
            onChange={(e) =>
              onChange({
                ...entry,
                statusChange: e.target.value
                  ? {
                      status: e.target.value as TaskStatus,
                      expectedVersion: entry.newTask
                        ? 1
                        : (tasks.find((t) => t.id === entry.taskId)?.version ??
                          1),
                    }
                  : undefined,
              })
            }
          >
            <option value="">不改变任务状态</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
    </details>
  );
}
