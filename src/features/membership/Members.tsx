import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import type { TeamMember } from "../../shared/contracts";
import { beijingDate } from "../../shared/time";
export function Members() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<TeamMember[]>("/members")
      .then(setMembers)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  return (
    <section className="members-page">
      <div className="journal-heading">
        <div>
          <h1>团队成员</h1>
        </div>
        <a className="primary" href="/invitations">
          管理成员邀请
        </a>
      </div>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">正在读取成员名单…</p>
      ) : (
        <ul className="invitation-list">
          {members.map((member) => (
            <li className="invitation-row" key={member.id}>
              <div className="invitation-detail">
                <h3>{member.name}</h3>
                <p>
                  加入于 {beijingDate(member.joinedAt)} ·{" "}
                  {member.lastDiaryDate
                    ? `最近提交 ${member.lastDiaryDate}`
                    : "尚未提交"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
