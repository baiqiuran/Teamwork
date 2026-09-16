export interface Identity {
  member: { id: string; name: string; email: string };
  team: { id: number; name: string };
}
export interface Invitation {
  id: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "used" | "revoked" | "expired";
}
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(0, "无法连接，请检查服务是否正在运行，然后重试。");
  }
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, result.error ?? "操作未完成，请重试。");
  return result;
}
