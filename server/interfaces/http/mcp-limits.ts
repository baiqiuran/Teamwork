import { HttpError } from "./http-error.ts";
export class McpLimits {
  private readonly windows = new Map<
    string,
    { until: number; count: number }
  >();
  constructor(
    private readonly memberLimit = 240,
    private readonly grantLimit = 120,
  ) {
    if (
      !Number.isInteger(memberLimit) ||
      memberLimit < 1 ||
      !Number.isInteger(grantLimit) ||
      grantLimit < 1
    )
      throw new Error("MCP 调用限额必须是正整数。");
  }
  consume(memberId: string, grantId: string) {
    const now = Date.now();
    for (const [key, value] of this.windows)
      if (value.until <= now) this.windows.delete(key);
    for (const [key, limit] of [
      [`member:${memberId}`, this.memberLimit],
      [`grant:${grantId}`, this.grantLimit],
    ] as const) {
      const current = this.windows.get(key) ?? { until: now + 60000, count: 0 };
      if (current.count >= limit)
        throw new HttpError(429, "MCP 调用过于频繁，请稍后重试。", {
          retryAfter: Math.ceil((current.until - now) / 1000),
        });
    }
    for (const key of [`member:${memberId}`, `grant:${grantId}`]) {
      const current = this.windows.get(key) ?? { until: now + 60000, count: 0 };
      current.count++;
      this.windows.set(key, current);
    }
  }
}
