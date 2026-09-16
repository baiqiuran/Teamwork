import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DiaryContent } from "./diaries";
import { statusLabels } from "./tasks";
import type { Project } from "./projects";
export interface PublishedDiary {
  id: string;
  author: { id: string; name: string };
  diaryDate: string;
  submittedAt: number;
  published: DiaryContent;
}
export const beijingToday = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export function DiaryRecords({
  records,
  publicToken,
  layout = "list",
}: {
  records: PublishedDiary[];
  publicToken?: string;
  layout?: "list" | "masonry";
}) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (layout !== "masonry" || !container.current) return;
    const grid = container.current;
    const cards = Array.from(
      grid.querySelectorAll<HTMLElement>(".record-card"),
    );
    // Measure the inner card, so the assigned grid span cannot feed back into its height.
    const measure = () => {
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 20;
      const sizes = cards.map((card) =>
        Math.ceil(card.getBoundingClientRect().height + gap),
      );
      cards.forEach((card, index) => {
        if (card.parentElement)
          card.parentElement.style.gridRowEnd = `span ${sizes[index]}`;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [records, layout]);
  return (
    <div
      ref={container}
      className={`records${layout === "masonry" ? " records--masonry" : ""}`}
    >
      {!records.length && (
        <div className="empty">所选范围内暂无已提交进展。</div>
      )}
      {records.map((d) => (
        <div className="record-cell" key={d.id}>
          <article className="record-card">
            <header className="record-meta">
              <span className="record-avatar" aria-hidden="true">
                {Array.from(d.author.name)[0]}
              </span>
              <div className="record-author">
                <strong>{d.author.name}</strong>
                <span>{d.diaryDate}</span>
              </div>
              <time
                dateTime={new Date(d.submittedAt).toISOString()}
                title={new Date(d.submittedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  hour12: false,
                })}
              >
                {new Date(d.submittedAt).toLocaleTimeString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                提交
              </time>
            </header>
            <h2>{d.published.title || "工作日报"}</h2>
            {d.published.entries.map((e, i) => (
              <section className="read-entry" key={e.id}>
                <div className="read-entry-meta">
                  <span className="entry-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {e.projectName && (
                    <span className="association-tag">@ {e.projectName}</span>
                  )}
                  {e.taskName && (
                    <span className="association-tag">
                      {e.taskName} · 提交时：
                      {e.taskStatus ? statusLabels[e.taskStatus] : ""}
                    </span>
                  )}
                </div>
                <p className="entry-body">{e.body}</p>
                {e.attachments && (
                  <ul className="attachment-links">
                    {e.attachments.map((file) => (
                      <li key={file.id}>
                        <a
                          href={
                            publicToken
                              ? `/api/public/${encodeURIComponent(publicToken)}/attachments/${file.id}`
                              : `/api/attachments/${file.id}`
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↓ {file.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </article>
        </div>
      ))}
    </div>
  );
}
export function TeamDiaries() {
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memberId, setMemberId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState(beijingToday());
  const [to, setTo] = useState(beijingToday());
  const [records, setRecords] = useState<PublishedDiary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load() {
    setError("");
    setLoading(true);
    try {
      setRecords(
        await api(
          `/team-diaries?from=${from}&to=${to}${memberId ? `&memberId=${memberId}` : ""}${projectId ? `&projectId=${projectId}` : ""}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    api<{ id: string; name: string }[]>("/members")
      .then(setMembers)
      .catch((e) => setError(e.message));
    api<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="team-diaries">
      <header className="team-diary-heading">
        <div>
          <h1>团队日报</h1>
          <p className="subtitle">每一份工作记录，都在这里。</p>
        </div>
        <span className="team-reading-note">已提交内容 · 北京时间</span>
      </header>
      <form
        className="filters team-diary-filters"
        aria-label="筛选团队日报"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
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
        <label>
          成员
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
          >
            <option value="">全部成员</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "查询中…" : "查看日报"}
        </button>
      </form>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      <div className="team-diary-results" aria-live="polite">
        <p>
          共 <strong>{records.length}</strong> 份日报
        </p>
        <span>最近提交在前</span>
      </div>
      <div aria-busy={loading}>
        <DiaryRecords records={records} layout="masonry" />
      </div>
    </section>
  );
}
