import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { fixture } from "./support.ts";
export const allScopes = [
  "progress:read",
  "drafts:write",
  "diaries:submit",
  "tasks:write",
  "shares:manage",
];
export async function authorize(
  f: Awaited<ReturnType<typeof fixture>>,
  scopes = allScopes,
  owner = f.author,
) {
  const verifier = randomBytes(32).toString("base64url");
  const request = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: `${f.origin}/mcp`,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: scopes.join(" "),
    state: "test-state",
  };
  const approval = await owner("/ai/authorize", {
    request,
    scopes,
    approve: true,
  });
  assert.equal(approval.status, 201);
  const response = await fetch(`${f.origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: request.client_id,
      redirect_uri: request.redirect_uri,
      resource: request.resource,
      code: new URL(approval.data.redirect).searchParams.get("code")!,
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
export async function mcpClient(origin: string, token: string) {
  const client = new Client({ name: "daily-flow-tests", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
