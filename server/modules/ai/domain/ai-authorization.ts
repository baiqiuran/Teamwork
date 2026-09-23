import { z } from "zod";

export const capabilities = [
  "progress:read",
  "drafts:write",
  "diaries:submit",
  "tasks:write",
  "shares:manage",
] as const;
export type Capability = (typeof capabilities)[number];
export const authorizationRequest = z.object({
  client_id: z.literal("daily-flow-codex"),
  redirect_uri: z.string().url(),
  resource: z.union([
    z.string().url(),
    z
      .array(z.string().url())
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === 1)
      .transform((values) => values[0]),
  ]),
  response_type: z.literal("code"),
  code_challenge_method: z.literal("S256"),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scope: z.string().max(500).default("progress:read drafts:write"),
  state: z.string().min(1).max(1024),
});
export type AuthorizationRequest = z.infer<typeof authorizationRequest>;
export interface AiGrant {
  id: string;
  memberId: string;
  clientId: string;
  resource: string;
  scopes: Capability[];
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number;
  lastReadSucceededAt: number | null;
  credentialType: "oauth" | "api-key";
  name: string | null;
}
export const createApiKeyInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(capabilities)).min(1).max(5),
  })
  .strict();
export interface ApiKeyCredential {
  hash: string;
  grantId: string;
}
export interface AuthorizationCode {
  hash: string;
  grantId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}
export interface AccessCredential {
  hash: string;
  grantId: string;
  expiresAt: number;
}
export class AuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export function validateAuthorization(
  input: unknown,
  resource: string,
  registeredRedirects: readonly string[],
) {
  const parsed = authorizationRequest.safeParse(input);
  if (!parsed.success)
    throw new AuthorizationError("invalid_request", "授权请求不合法。");
  const value = parsed.data,
    redirect = new URL(value.redirect_uri);
  const registered = registeredRedirects.some((value) => {
    const allowed = new URL(value);
    return (
      redirect.protocol === allowed.protocol &&
      redirect.hostname === allowed.hostname &&
      redirect.pathname === allowed.pathname &&
      (allowed.port === "" || redirect.port === allowed.port)
    );
  });
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
    !registered ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw new AuthorizationError("invalid_request", "回调地址未登记。");
  if (value.resource !== resource)
    throw new AuthorizationError("invalid_target", "目标资源不匹配。");
  const scopes = value.scope.split(" ").filter(Boolean);
  if (
    !scopes.length ||
    scopes.some((s) => !capabilities.includes(s as Capability))
  )
    throw new AuthorizationError("invalid_scope", "请求能力不受支持。");
  return { request: value, scopes: [...new Set(scopes)] as Capability[] };
}
