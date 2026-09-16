import { useLayoutEffect, useRef } from "react";
import type { PublishedDiary } from "../contracts";
import { statusLabels } from "../status";
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
