import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import type {
  Entry,
  Diary,
  DiaryContent,
  TaskStatus,
  Project,
} from "../../shared/contracts";
import { TaskAssociation } from "./TaskAssociation";
import { statusLabels } from "../../shared/status";
interface PendingUpload {
  entry: Entry;
  file: File;
  requestId: string;
  version?: number;
}
const emptyEntry = (): Entry => ({ id: crypto.randomUUID(), body: "" });
export function Diaries() {
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(
    null,
  );
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
    const diaryId = new URLSearchParams(window.location.search).get("diary");
    if (diaryId)
      api<Diary>(`/diaries/${encodeURIComponent(diaryId)}`)
        .then(open)
        .catch((e) => setError(e.message));
    api<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || pendingUpload) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pendingUpload]);
  useEffect(() => {
    if (!current?.diaryDate) return;
    const id = current.id;
    let disposed = false;
    const checkWindow = async () => {
      try {
        const latest = await api<Diary>(`/diaries/${id}`);
        if (!disposed)
          setCurrent((value) =>
            value?.id === id ? { ...value, editable: latest.editable } : value,
          );
      } catch {
        /* Preserve unsaved text when connectivity is interrupted. */
      }
    };
    const interval = window.setInterval(checkWindow, 60_000);
    window.addEventListener("focus", checkWindow);
    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", checkWindow);
    };
  }, [current?.id, current?.diaryDate]);
  function open(diary: Diary) {
    setConflicts([]);
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
    if (pendingUpload) throw new Error("请先重试或放弃未完成上传的附件。");
    if (dirty && !window.confirm("当前修改尚未保存，放弃修改并新建？")) return;
    const diary = await api<Diary>("/diaries", {
      title: "",
      entries: [emptyEntry()],
    });
    open(diary);
    await refresh();
  }
  async function persistDraft(force = false): Promise<Diary> {
    if (!current) throw new Error("请先选择日报。");
    if (!dirty && !force) return current;
    const diary = await api<Diary>(`/diaries/${current.id}/save`, {
      ...content,
      version: current.version,
    });
    open(diary);
    return diary;
  }
  async function save() {
    await persistDraft(true);
    setNotice("草稿已保存，仅你可见。");
    await refresh();
  }
  async function submit() {
    if (!current) return;
    if (pendingUpload) throw new Error("请先重试或放弃未完成上传的附件。");
    const diary = await persistDraft();
    const result = await api<Diary>(`/diaries/${diary.id}/submit`, {
      version: diary.version,
      requestId: crypto.randomUUID(),
    });
    open(result);
    await refresh();
    setNotice("日报已提交，团队可以查看。");
  }
  async function upload(entry: Entry, file: File, retry?: PendingUpload) {
    if (!current) return;
    let pending: PendingUpload = retry ?? {
      entry,
      file,
      requestId: crypto.randomUUID(),
    };
    setPendingUpload(pending);
    const diary =
      pending.version === undefined ? await persistDraft() : current;
    pending = { ...pending, version: pending.version ?? diary.version };
    setPendingUpload(pending);
    if (file.size > 20 * 1024 * 1024)
      throw new Error("单个文件不能超过 20 MB。");
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("无法读取文件，请重试。"));
      reader.readAsDataURL(file);
    });
    const updated = await api<Diary>(
      `/diaries/${diary.id}/entries/${entry.id}/attachments`,
      {
        version: pending.version,
        requestId: pending.requestId,
        name: file.name,
        base64,
      },
    );
    open(updated);
    setPendingUpload(null);
    await refresh();
    setNotice("附件已保存到草稿，提交后团队才可见。");
  }
  return (
    <>
      <div className="journal-heading">
        <div>
          <p className="eyebrow">日报</p>
          <h1>我的日报</h1>
          <p className="subtitle">保存草稿仅自己可见，提交后团队可见。</p>
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
      {pendingUpload && !busy && (
        <section className="conflict-panel">
          <h2>附件尚未完成上传</h2>
          <p>{pendingUpload.file.name} 尚未确认加入日报，请先处理。</p>
          <button
            className="secondary"
            onClick={() =>
              action(() =>
                upload(pendingUpload.entry, pendingUpload.file, pendingUpload),
              )
            }
          >
            重试上传
          </button>
          <button
            className="secondary"
            onClick={() =>
              action(async () => {
                if (pendingUpload.version === undefined) {
                  setPendingUpload(null);
                  setNotice("已取消上传，请继续修改尚未保存的正文。");
                  return;
                }
                const diary = await api<Diary>(
                  `/diaries/${current!.id}/attachments/cancel`,
                  { requestId: pendingUpload.requestId },
                );
                open(diary);
                setPendingUpload(null);
                setNotice("已放弃此附件，正文草稿保留。");
                await refresh();
              })
            }
          >
            放弃此附件
          </button>
        </section>
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
          {items.length === 0 && <p className="muted">暂无日报。</p>}
          {items.map((item) => (
            <button
              key={item.id}
              className={`draft-item ${current?.id === item.id ? "selected" : ""}`}
              disabled={busy}
              onClick={() =>
                action(async () => {
                  if (pendingUpload) throw new Error("请先处理未完成的附件。");
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
        <section
          className={`diary-editor${dirty ? " dirty" : ""}`}
          aria-label="日报编辑器"
        >
          {!current ? (
            <div className="empty">
              <h2>新建或选择日报</h2>
              <p>草稿仅自己可见，提交后团队可见。</p>
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
                  只能在首次提交当天修改日报。未再次提交的修改仍仅你可见。
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
                disabled={busy || !current.editable || !!pendingUpload}
                className="editor-fields"
              >
                <label className="title-field">
                  日报标题 <span className="muted">选填</span>
                  <input
                    aria-label="日报标题"
                    placeholder="输入日报标题（选填）"
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
                        placeholder={
                          "输入工作内容，可换行、分段或用 - 编写列表。"
                        }
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
                            ? "提交后显示在此项目的进展中"
                            : "未关联项目，仅保留在完整日报中"}
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
                        <details>
                          <summary>添加附件</summary>
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
                                if (file)
                                  void action(() => upload(entry, file));
                              }}
                            />
                          </label>
                          <small>
                            每条最多 10 个，每个 20
                            MB；图片、PDF、TXT、CSV、Office
                            文档。上传会先保存当前草稿。
                          </small>
                        </details>
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
                  disabled={busy || !current.editable || !!pendingUpload}
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
                    className="secondary"
                    disabled={busy || !current.editable || !!pendingUpload}
                    onClick={() => action(save)}
                  >
                    {busy ? "保存中…" : "保存草稿"}
                  </button>
                </div>
                <button
                  className="primary"
                  disabled={busy || !current.editable || !!pendingUpload}
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
