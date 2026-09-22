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
          <p className="eyebrow">当前团队</p>
          <h1>团队成员</h1>
          <p className="subtitle">
            显示本团队全部成员、加入日期和最近一次已提交日报的日期。
          </p>
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
      <p className="field-hint">
        成员名单仅限本团队查看；新成员通过成员邀请加入，加入日期按北京时间显示。
      </p>
    </section>
  );
}
