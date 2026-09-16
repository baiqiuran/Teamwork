import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { TaskAssociation, statusLabels, type TaskStatus } from "./tasks";
import type { Project } from "./projects";

export interface Entry {
  id: string;
  body: string;
  attachments?: { id: string; name: string; size: number }[];
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  taskStatus?: TaskStatus;
  newTask?: { name: string; description: string };
  statusChange?: {
    status: TaskStatus;
    expectedVersion: number;
    resolution?: "keep" | "apply";
  };
}
export interface DiaryContent {
  title: string;
  entries: Entry[];
}
export interface Diary {
  id: string;
  draft: DiaryContent;
  version: number;
  diaryDate: string | null;
  updatedAt: number;
  published: DiaryContent | null;
  editable: boolean;
}
const emptyEntry = (): Entry => ({ id: crypto.randomUUID(), body: "" });
export function Diaries() {
  const [conflicts, setConflicts] = useState<
    NonNullable<ApiError["details"]>["conflicts"]
  >([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [associating, setAssociating] = useState<string | null>(null);
  const [items, setItems] = useState<Diary[]>([]);
  const [current, setCurrent] = useState<Diary | null>(null);
  const [content, setContent] = useState<DiaryContent>({
    title: "",
    entries: [],
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async () => setItems(await api<Diary[]>("/diaries/mine"));
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function open(diary: Diary) {
    setCurrent(diary);
    setContent(diary.draft);
    setDirty(false);
    setNotice("");
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (e instanceof ApiError && e.details?.conflicts)
        setConflicts(e.details.conflicts);
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  function edit(next: DiaryContent) {
    setContent(next);
    setDirty(true);
    setNotice("");
  }
  async function create() {
    if (dirty && !window.confirm("当前修改尚未保存，放弃修改并新建？")) return;
    const diary = await api<Diary>("/diaries", {
      title: "",
      entries: [emptyEntry()],
    });
    open(diary);
    await refresh();
  }
  async function save() {
    if (!current) return;
    const diary = await api<Diary>(`/diaries/${current.id}/save`, {
      ...content,
      version: current.version,
    });
    open(diary);
    setNotice("草稿已保存，仅你可见。");
    await refresh();
  }
  async function submit() {
    if (!current) return;
    let diary = current;
    if (dirty) {
      diary = await api<Diary>(`/diaries/${current.id}/save`, {
        ...content,
        version: current.version,
      });
      open(diary);
    }
    const result = await api<Diary>(`/diaries/${diary.id}/submit`, {
      version: diary.version,
      requestId: crypto.randomUUID(),
    });
    open(result);
    await refresh();
    setNotice("日报已提交，团队可以查看。");
  }
  async function upload(entry: Entry, file: File) {
    if (!current) return;
    if (file.size > 20 * 1024 * 1024)
      throw new Error("单个文件不能超过 20 MB。");
    let diary = current;
    if (dirty) {
      diary = await api<Diary>(`/diaries/${current.id}/save`, {
        ...content,
        version: current.version,
      });
      open(diary);
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("无法读取文件，请重试。"));
      reader.readAsDataURL(file);
    });
    const updated = await api<Diary>(
      `/diaries/${diary.id}/entries/${entry.id}/attachments`,
      {
        version: diary.version,
        requestId: crypto.randomUUID(),
        name: file.name,
        base64,
      },
    );
    open(updated);
    await refresh();
    setNotice("附件已保存到私人草稿，提交后才对团队可见。");
  }
  return (
    <>
      <div className="journal-heading">
        <div>
          <p className="eyebrow">我的日报</p>
          <h1>记下今天的进展</h1>
          <p className="subtitle">一条工作，一段完整记录。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => action(create)}
        >
          ＋ 新建日报
        </button>
      </div>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      <div className="journal-layout">
        {conflicts && conflicts.length > 0 && (
          <section className="conflict-panel" role="alert">
            <h2>任务有新的状态，请确认本次提交</h2>
            {conflicts.map((c) => (
              <div key={c.taskId}>
                <p>
                  <strong>{c.taskName}</strong>：最新{" "}
                  {statusLabels[c.latestStatus as TaskStatus]}，你选择{" "}
                  {statusLabels[c.requestedStatus as TaskStatus]}
                </p>
                {(["keep", "apply"] as const).map((choice) => (
                  <button
                    className="secondary"
                    key={choice}
                    onClick={() => {
                      edit({
                        ...content,
                        entries: content.entries.map((e) =>
                          e.taskId === c.taskId && e.statusChange
                            ? {
                                ...e,
                                statusChange: {
                                  ...e.statusChange,
                                  expectedVersion: c.latestVersion,
                                  resolution: choice,
                                },
                              }
                            : e,
                        ),
                      });
                      setConflicts(
                        conflicts.filter((item) => item.taskId !== c.taskId),
                      );
                    }}
                  >
                    {choice === "keep" ? "保留最新状态" : "执行我选择的状态"}
                  </button>
                ))}
              </div>
            ))}
            <button className="text-button" onClick={() => setConflicts([])}>
              取消处理，保留草稿
            </button>
          </section>
        )}
        <aside className="draft-list" aria-label="我的日报列表">
          <h2>
            最近记录 <span className="count">{items.length}</span>
          </h2>
          {items.length === 0 && (
            <p className="muted">还没有日报，开始第一份记录吧。</p>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              className={`draft-item ${current?.id === item.id ? "selected" : ""}`}
              disabled={busy}
              onClick={() =>
                action(async () => {
                  if (
                    dirty &&
                    !window.confirm("当前修改尚未保存，放弃修改并切换？")
                  )
                    return;
                  open(await api<Diary>(`/diaries/${item.id}`));
                })
              }
            >
              <strong>{item.draft.title || "未命名日报"}</strong>
              <span>
                {item.diaryDate ? `${item.diaryDate} · 已提交` : "私人草稿"} ·{" "}
                {item.draft.entries.length} 条工作
              </span>
            </button>
          ))}
        </aside>
        <section className="diary-editor" aria-label="日报编辑器">
          {!current ? (
            <div className="empty">
              <h2>从一条工作开始</h2>
              <p>先写内容，随时保存；草稿仅自己可见。</p>
              <button
                className="secondary"
                onClick={() => action(create)}
                disabled={busy}
              >
                开始写日报
              </button>
            </div>
          ) : (
            <>
              <div className="editor-meta">
                <span>
                  {current.diaryDate
                    ? `${current.diaryDate} · 已提交`
                    : "私人草稿 · 仅自己可见"}
                </span>
                <span>{dirty ? "有未保存修改" : "已保存"}</span>
              </div>
              {!current.editable && (
                <p className="message">
                  历史日报已锁定。此处保留的未重提修改仅你可见。
                </p>
              )}
              {current.published && (
                <details className="published-preview">
                  <summary>查看团队正在阅读的提交版本</summary>
                  <h3>{current.published.title || "工作日报"}</h3>
                  {current.published.entries.map((e) => (
                    <p className="entry-body" key={e.id}>
                      {e.body}
                    </p>
                  ))}
                </details>
              )}
              <fieldset
                disabled={busy || !current.editable}
                className="editor-fields"
              >
                <label className="title-field">
                  日报标题 <span className="muted">选填</span>
                  <input
                    aria-label="日报标题"
                    placeholder="为这份记录起个名字"
                    value={content.title}
                    disabled={busy}
                    onChange={(e) =>
                      edit({ ...content, title: e.target.value })
                    }
                  />
                </label>
                <div className="work-entries">
                  {content.entries.map((entry, index) => (
                    <article className="work-entry" key={entry.id}>
                      <div className="entry-heading">
                        <label htmlFor={`body-${entry.id}`}>
                          工作 {index + 1}
                        </label>
                        <div className="inline-actions">
                          <button
                            className="text-button"
                            disabled={busy || index === 0}
                            aria-label={`上移工作 ${index + 1}`}
                            onClick={() => {
                              const entries = [...content.entries];
                              [entries[index - 1], entries[index]] = [
                                entries[index],
                                entries[index - 1],
                              ];
                              edit({ ...content, entries });
                            }}
                          >
                            上移
                          </button>
                          <button
                            className="text-button danger"
                            disabled={busy}
                            aria-label={`移除工作 ${index + 1}`}
                            onClick={() => {
                              if (
                                entry.body &&
                                !window.confirm("移除这条工作？保存后生效。")
                              )
                                return;
                              edit({
                                ...content,
                                entries: content.entries.filter(
                                  (e) => e.id !== entry.id,
                                ),
                              });
                            }}
                          >
                            移除
                          </button>
                        </div>
                      </div>
                      <textarea
                        onKeyDown={(e) => {
                          if (e.key === "@") {
                            e.preventDefault();
                            setAssociating(entry.id);
                            api<Project[]>("/projects")
                              .then(setProjects)
                              .catch((e) => setError(e.message));
                          }
                        }}
                        id={`body-${entry.id}`}
                        value={entry.body}
                        disabled={busy}
                        placeholder="完成了什么？有哪些进展？\n可以换行、分段，或用 - 编写列表。"
                        onChange={(e) =>
                          edit({
                            ...content,
                            entries: content.entries.map((item) =>
                              item.id === entry.id
                                ? { ...item, body: e.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                      <div className="entry-association">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setAssociating(
                              associating === entry.id ? null : entry.id,
                            );
                            api<Project[]>("/projects")
                              .then(setProjects)
                              .catch((e) => setError(e.message));
                          }}
                        >
                          {entry.projectId
                            ? `@ ${projects.find((p) => p.id === entry.projectId)?.name || entry.projectName || "项目"}`
                            : "@ 关联项目"}
                        </button>
                        <span className="muted">
                          {entry.projectId
                            ? "整个条目提交后归入此项目"
                            : "保留在完整日报中"}
                        </span>
                        {associating === entry.id && (
                          <label>
                            关联项目
                            <select
                              aria-label={`工作 ${index + 1} 关联项目`}
                              value={entry.projectId || ""}
                              onChange={(e) => {
                                const projectId = e.target.value || undefined;
                                edit({
                                  ...content,
                                  entries: content.entries.map((item) =>
                                    item.id === entry.id
                                      ? {
                                          ...item,
                                          projectId,
                                          taskId: undefined,
                                          taskName: undefined,
                                          taskStatus: undefined,
                                          newTask: undefined,
                                          statusChange: undefined,
                                          projectName: projects.find(
                                            (p) => p.id === projectId,
                                          )?.name,
                                        }
                                      : item,
                                  ),
                                });
                              }}
                            >
                              <option value="">不关联项目</option>
                              {projects
                                .filter(
                                  (p) =>
                                    !p.archived || p.id === entry.projectId,
                                )
                                .map((p) => (
                                  <option value={p.id} key={p.id}>
                                    {p.name}
                                    {p.archived ? "（已归档）" : ""}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                      </div>
                      <TaskAssociation
                        entry={entry}
                        index={index}
                        onChange={(next) =>
                          edit({
                            ...content,
                            entries: content.entries.map((e) =>
                              e.id === next.id ? next : e,
                            ),
                          })
                        }
                      />
                      <div className="attachments">
                        <ul>
                          {entry.attachments?.map((file) => (
                            <li key={file.id}>
                              <a
                                href={`/api/attachments/${file.id}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {file.name}
                              </a>
                              <small>{Math.ceil(file.size / 1024)} KB</small>
                              <button
                                className="text-button danger"
                                aria-label={`移除附件 ${file.name}`}
                                onClick={() =>
                                  edit({
                                    ...content,
                                    entries: content.entries.map((e) =>
                                      e.id === entry.id
                                        ? {
                                            ...e,
                                            attachments: e.attachments?.filter(
                                              (a) => a.id !== file.id,
                                            ),
                                          }
                                        : e,
                                    ),
                                  })
                                }
                              >
                                移除
                              </button>
                            </li>
                          ))}
                        </ul>
                        <label className="file-input">
                          添加附件
                          <input
                            type="file"
                            aria-label={`工作 ${index + 1} 添加附件`}
                            accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.docx,.xlsx,.pptx"
                            disabled={
                              busy || (entry.attachments?.length ?? 0) >= 10
                            }
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = "";
                              if (file) void action(() => upload(entry, file));
                            }}
                          />
                        </label>
                        <small>
                          每条最多 10 个，每个 20
                          MB；图片、PDF、TXT、CSV、Office
                          文档。上传会先保存当前草稿。
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
                <button
                  className="add-entry"
                  disabled={busy || content.entries.length >= 50}
                  onClick={() =>
                    edit({
                      ...content,
                      entries: [...content.entries, emptyEntry()],
                    })
                  }
                >
                  ＋ 新增一条工作
                </button>
                <p className="field-hint">
                  换行仍属于当前工作；新增条目后，可单独记录下一项工作。
                </p>
              </fieldset>
              <div className="editor-actions">
                <button
                  className="text-button danger"
                  disabled={busy || !current.editable}
                  onClick={() =>
                    action(async () => {
                      if (
                        !window.confirm(
                          "删除这份日报？已提交内容也会从团队和分享中移除。",
                        )
                      )
                        return;
                      await api(`/diaries/${current.id}/delete`, {
                        version: current.version,
                      });
                      setCurrent(null);
                      setDirty(false);
                      await refresh();
                    })
                  }
                >
                  {current.diaryDate ? "删除日报" : "删除草稿"}
                </button>
                <div>
                  <span role="status">{notice}</span>
                  <button
                    className="primary"
                    disabled={busy || !current.editable}
                    onClick={() => action(save)}
                  >
                    {busy ? "保存中…" : "保存草稿"}
                  </button>
                </div>
                <button
                  className="primary"
                  disabled={busy || !current.editable}
                  onClick={() => action(submit)}
                >
                  {current.diaryDate ? "重新提交" : "提交日报"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
