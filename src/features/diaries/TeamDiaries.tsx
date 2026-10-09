import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { DiaryRecords } from "../../shared/components/DiaryRecords";
import { beijingToday } from "../../shared/time";
import type {
  Project,
  PublishedDiary,
  TeamMember,
} from "../../shared/contracts";
import "./TeamDiaries.css";
export function TeamDiaries() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memberId, setMemberId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [records, setRecords] = useState<PublishedDiary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load(range = { from, to }) {
    setError("");
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (range.from) query.set("from", range.from);
      if (range.to) query.set("to", range.to);
      if (memberId) query.set("memberId", memberId);
      if (projectId) query.set("projectId", projectId);
      setRecords(await api(`/team-diaries${query.size ? `?${query}` : ""}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function showDates(from: string, to: string) {
    setFrom(from);
    setTo(to);
    void load({ from, to });
  }
  useEffect(() => {
    void load();
    api<TeamMember[]>("/members")
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
        </div>
        <div className="team-diary-heading-actions">
          <span className="team-reading-note">已提交内容 · 北京时间</span>
          <div className="team-diary-date-shortcuts" aria-label="快捷日期筛选">
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => showDates("", "")}
            >
              全部日期
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => {
                const today = beijingToday();
                showDates(today, today);
              }}
            >
              只看今天
            </button>
          </div>
        </div>
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
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
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
