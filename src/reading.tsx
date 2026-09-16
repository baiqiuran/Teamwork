import { useEffect, useState } from "react";
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
}: {
  records: PublishedDiary[];
  publicToken?: string;
}) {
  return (
    <div className="records">
      {!records.length && (
        <div className="empty">所选范围内暂无已提交进展。</div>
      )}
      {records.map((d) => (
        <article className="record-card" key={d.id}>
          <div className="record-meta">
            <strong>{d.author.name}</strong>
            <span>
              {d.diaryDate} ·{" "}
              {new Date(d.submittedAt).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour12: false,
              })}{" "}
              提交
            </span>
          </div>
          <h2>{d.published.title || "工作日报"}</h2>
          {d.published.entries.map((e, i) => (
            <section className="read-entry" key={e.id}>
              <span className="muted">工作 {i + 1}</span>
              {e.projectName && (
                <span className="association-tag">@ {e.projectName}</span>
              )}
              {e.taskName && (
                <span className="association-tag">
                  {e.taskName} · 提交时：
                  {e.taskStatus ? statusLabels[e.taskStatus] : ""}
                </span>
              )}
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
  async function load() {
    setError("");
    try {
      setRecords(
        await api(
          `/team-diaries?from=${from}&to=${to}${memberId ? `&memberId=${memberId}` : ""}${projectId ? `&projectId=${projectId}` : ""}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
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
    <>
      <div className="page-intro">
        <p className="eyebrow">团队日报</p>
        <h1>每个人的进展，在这里汇合</h1>
        <p className="subtitle">阅读完整已提交日报。日期以北京时间为准。</p>
      </div>
      <form
        className="filters"
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
        <button className="secondary">查看日报</button>
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
      </form>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      <p className="muted">共 {records.length} 份日报</p>
      <DiaryRecords records={records} />
    </>
  );
}
