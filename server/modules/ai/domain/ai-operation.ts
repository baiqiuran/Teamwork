import type { Capability } from "./ai-authorization.ts";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export interface AiReceipt {
  memberId: string;
  operationId: string;
  tool: string;
  fingerprint: string;
  grantId: string;
  scopes: Capability[];
  result: Record<string, unknown>;
}
export interface AiOperation {
  id: string;
  memberId: string;
  grantId: string;
  clientId: string;
  tool: string;
  objectId: string | null;
  at: number;
  outcome: "success" | "failure" | "replay";
  errorCode: string | null;
}
