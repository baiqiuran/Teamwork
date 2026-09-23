import { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import type { Invitation } from "../../shared/contracts";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
import { formatDate } from "../../shared/time";
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
export function Invitations({ onExpired }: { onExpired: () => void }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      onExpired();
      return;
    }
    setError(describeError(error));
  }
  async function load() {
    const result = await api<{ invitations: Invitation[] }>("/invitations");
    setInvitations(result.invitations);
    setFresh((current) =>
      current &&
      result.invitations.some(
        (item) => item.id === current.id && item.status === "active",
      )
        ? current
        : null,
    );
  }
  useEffect(() => {
    load()
      .catch(fail)
      .finally(() => setLoading(false));
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    const result = await api<{ invitation: { id: string }; joinPath: string }>(
      "/invitations",
      {},
    );
    setFresh({
      id: result.invitation.id,
      url: new URL(result.joinPath, window.location.origin).href,
    });
    await load();
    setNotice("邀请已生成。请复制链接，发送给一位同事。");
  }
  const labels = {
    active: "待接受",
    used: "已接受",
    revoked: "已撤销",
    expired: "已过期",
  };
  return (
    <>
      <div className="page-intro">
        <h1>成员邀请</h1>
      </div>
      <section className="invite-panel" aria-labelledby="new-invite-title">
        <div className="invite-main">
          <h2 id="new-invite-title">生成邀请</h2>
          <button
            className="primary"
            onClick={() => perform(create)}
            disabled={busy || loading}
          >
            {busy ? "处理中…" : "生成邀请链接"}
            <Arrow />
          </button>
        </div>
        <div className="invite-notes">
          <span className="note-symbol" aria-hidden="true">
            ↗
          </span>
          <h3>邀请规则</h3>
          <ul>
            <li>链接在 7 天内有效</li>
            <li>仅可使用一次，成功加入后自动失效</li>
            <li>仅生成者可以撤销尚未使用的邀请</li>
          </ul>
        </div>
      </section>
      <Message error>{error}</Message>
      <Message>{notice}</Message>
      {fresh && (
        <section className="fresh-invite">
          <label>
            新邀请链接
            <input
              value={fresh.url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button
            className="secondary"
            onClick={() =>
              perform(async () => {
                try {
                  await navigator.clipboard.writeText(fresh.url);
                  setNotice("邀请链接已复制。");
                } catch {
                  setNotice("请选择链接文字并手动复制。");
                }
              })
            }
            disabled={busy}
          >
            复制链接
          </button>
          <small>请现在保存链接；离开页面后如需再次邀请，可生成新链接。</small>
        </section>
      )}
      <section className="history" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <h2 id="history-title">
              我发出的邀请 <span className="count">{invitations.length}</span>
            </h2>
          </div>
          <button
            className="text-button"
            disabled={busy || loading}
            onClick={() => perform(load)}
          >
            刷新列表 ↻
          </button>
        </div>
        {loading ? (
          <p role="status" className="empty">
            正在读取邀请…
          </p>
        ) : invitations.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              ＋
            </div>
            <h3>还没有发出的邀请</h3>
          </div>
        ) : (
          <div className="invitation-list">
            {invitations.map((invitation) => (
              <article className="invitation-row" key={invitation.id}>
                <span className="invite-avatar" aria-hidden="true">
                  ↗
                </span>
                <div className="invitation-detail">
                  <h3>邀请 {invitation.id.slice(0, 6).toUpperCase()}</h3>
                  <p>
                    {formatDate(invitation.createdAt)} 发出{" "}
                    <span>· {formatDate(invitation.expiresAt)} 到期</span>
                  </p>
                </div>
                <span className={`status ${invitation.status}`}>
                  {labels[invitation.status]}
                </span>
                <div className="row-action">
                  {invitation.status === "active" && (
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await api(`/invitations/${invitation.id}/revoke`, {});
                          await load();
                          setNotice("邀请已撤销，原链接不能再加入团队。");
                        })
                      }
                    >
                      撤销
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
