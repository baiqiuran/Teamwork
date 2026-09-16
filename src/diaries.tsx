import { useEffect, useState } from "react";
import { api } from "./api";

export interface Entry {
  id: string;
  body: string;
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
}
const emptyEntry = (): Entry => ({ id: crypto.randomUUID(), body: "" });
export function Diaries() {
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
              <span>私人草稿 · {item.draft.entries.length} 条工作</span>
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
                <span>私人草稿 · 仅自己可见</span>
                <span>{dirty ? "有未保存修改" : "已保存"}</span>
              </div>
              <label className="title-field">
                日报标题 <span className="muted">选填</span>
                <input
                  aria-label="日报标题"
                  placeholder="为这份记录起个名字"
                  value={content.title}
                  disabled={busy}
                  onChange={(e) => edit({ ...content, title: e.target.value })}
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
              <div className="editor-actions">
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      if (!window.confirm("删除这份私人草稿？此操作无法撤销。"))
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
                  删除草稿
                </button>
                <div>
                  <span role="status">{notice}</span>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => action(save)}
                  >
                    {busy ? "保存中…" : "保存草稿"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
