import { z } from "zod";
import { DomainError } from "./errors.ts";
export const beijingDate = (timestamp: number) =>
  new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 10);
export interface DateRange {
  from: string;
  to: string;
}
export function dateRange(query: Record<string, unknown>): DateRange {
  const from = query.from ? z.iso.date().parse(query.from) : "0001-01-01";
  const to = query.to ? z.iso.date().parse(query.to) : "9999-12-31";
  if (from > to) throw new DomainError("invalid", "开始日期不能晚于结束日期。");
  return { from, to };
}
