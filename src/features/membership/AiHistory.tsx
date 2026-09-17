import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { Message } from "../../shared/components/Message";
import { describeError } from "../../shared/errors";
type Operation = {
  id: string;
  grantId: string;
  clientId: string;
  tool: string;
  objectId: string | null;
  at: number;
  outcome: "success" | "failure" | "replay";
  errorCode: string | null;
  object: { state: string; url?: string };
};
type Page = { items: Operation[]; nextCursor: string | null };
const tools: Record<string, string> = {
  create_draft: "新建草稿",
  update_draft: "补充日报",
  submit_diary: "提交日报",
  create_task: "创建任务",
  update_task_status: "更新任务状态",
  create_share: "创建公开链接",
  close_share: "关闭公开链接",
};
const outcomes = { success: "成功", failure: "失败", replay: "重放回执" };
export function AiHistory() {
  const requestVersion = useRef(0);
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null }),
    [outcome, setOutcome] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load(cursor?: string) {
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (outcome) params.set("outcome", outcome);
      if (cursor) params.set("cursor", cursor);
      const next = await api<Page>(`/ai/operations?${params}`);
      if (version !== requestVersion.current) return;
      setPage((current) => ({
        ...next,
        items: cursor ? [...current.items, ...next.items] : next.items,
      }));
    } catch (e) {
      if (version === requestVersion.current) setError(describeError(e));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  useEffect(() => {
    setPage({ items: [], nextCursor: null });
    void load();
    return () => {
      requestVersion.current++;
    };
  }, [outcome]);
  return (
    <section aria-label="AI 操作记录">
      <h2>我的 AI 操作记录</h2>
      <p>
        记录当时的执行结果；对象状态显示当前情况。重放回执不会再次修改业务数据。
      </p>
      <label>
        执行结果{" "}
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="failure">失败</option>
          <option value="replay">重放回执</option>
        </select>
      </label>
      <button className="secondary" disabled={busy} onClick={() => void load()}>
        刷新记录
      </button>
      <Message error>{error}</Message>
      {!busy && !page.items.length && <p>暂无操作记录。</p>}
      {page.items.map((item) => (
        <article
          className="account-card"
          key={item.id}
          style={{ marginBlock: 12 }}
        >
          <strong>
            {tools[item.tool] ?? item.tool} · {outcomes[item.outcome]}
          </strong>
          <p>
            {new Date(item.at).toLocaleString("zh-CN")} · Codex · 连接{" "}
            {item.grantId.slice(0, 8)}
          </p>
          <p>
            {item.object.state}
            {item.object.url && (
              <>
                {" "}
                · <a href={item.object.url}>查看对象</a>
              </>
            )}
          </p>
          {item.errorCode && <p>错误码：{item.errorCode}</p>}
          <details>
            <summary>记录详情</summary>
            <p>工具：{item.tool}</p>
            <p>对象：{item.objectId ?? "未产生对象"}</p>
            <p>连接：{item.grantId}</p>
          </details>
        </article>
      ))}
      {page.nextCursor && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          加载更多
        </button>
      )}
    </section>
  );
}
