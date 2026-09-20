import type { DatabaseSync } from "node:sqlite";
import type { AiAuthorizationRepository } from "../../application/ports.ts";
import type { Capability } from "../../domain/ai-authorization.ts";
export function aiAuthorizationRepository(
  db: DatabaseSync,
  redirects: readonly string[],
): AiAuthorizationRepository {
  db.prepare(
    "INSERT INTO ai_clients (id,name,redirect_uris) VALUES ('daily-flow-codex','Codex',?) ON CONFLICT(id) DO UPDATE SET redirect_uris=excluded.redirect_uris",
  ).run(JSON.stringify(redirects));
  const repository: AiAuthorizationRepository = {
    registeredRedirects() {
      const row = db
        .prepare(
          "SELECT redirect_uris FROM ai_clients WHERE id='daily-flow-codex'",
        )
        .get();
      return row ? JSON.parse(String(row.redirect_uris)) : [];
    },
    grants(memberId) {
      return db
        .prepare(
          "SELECT id FROM ai_grants WHERE member_id=? ORDER BY created_at DESC,id",
        )
        .all(memberId)
        .map((row) => repository.grant(String(row.id))!);
    },
    refresh(hash) {
      const row = db
        .prepare("SELECT grant_id FROM ai_refresh WHERE hash=?")
        .get(hash);
      return row ? { hash, grantId: String(row.grant_id) } : undefined;
    },
    saveRefresh(value) {
      db.prepare("INSERT INTO ai_refresh (hash,grant_id) VALUES (?,?)").run(
        value.hash,
        value.grantId,
      );
    },
    removeRefresh(hash) {
      db.prepare("DELETE FROM ai_refresh WHERE hash=?").run(hash);
    },
    grant(id) {
      const row = db.prepare("SELECT * FROM ai_grants WHERE id=?").get(id);
      return row
        ? {
            id: String(row.id),
            memberId: String(row.member_id),
            clientId: String(row.client_id),
            resource: String(row.resource),
            scopes: JSON.parse(String(row.scopes)) as Capability[],
            createdAt: Number(row.created_at),
            lastUsedAt: Number(row.last_used_at),
            revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
            credentialType:
              row.credential_type === "api-key" ? "api-key" : "oauth",
            name: row.name === null ? null : String(row.name),
          }
        : undefined;
    },
    saveGrant(g) {
      db.prepare(
        "INSERT INTO ai_grants (id,member_id,client_id,resource,scopes,created_at,revoked_at,last_used_at,credential_type,name) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revoked_at=excluded.revoked_at,last_used_at=excluded.last_used_at",
      ).run(
        g.id,
        g.memberId,
        g.clientId,
        g.resource,
        JSON.stringify(g.scopes),
        g.createdAt,
        g.revokedAt,
        g.lastUsedAt,
        g.credentialType,
        g.name,
      );
    },
    code(hash) {
      const r = db.prepare("SELECT * FROM ai_codes WHERE hash=?").get(hash);
      return r
        ? {
            hash,
            grantId: String(r.grant_id),
            redirectUri: String(r.redirect_uri),
            challenge: String(r.challenge),
            expiresAt: Number(r.expires_at),
          }
        : undefined;
    },
    saveCode(c) {
      db.prepare(
        "INSERT INTO ai_codes (hash,grant_id,redirect_uri,challenge,expires_at) VALUES (?,?,?,?,?)",
      ).run(c.hash, c.grantId, c.redirectUri, c.challenge, c.expiresAt);
    },
    removeCode(hash) {
      db.prepare("DELETE FROM ai_codes WHERE hash=?").run(hash);
    },
    access(hash) {
      const r = db.prepare("SELECT * FROM ai_access WHERE hash=?").get(hash);
      return r
        ? { hash, grantId: String(r.grant_id), expiresAt: Number(r.expires_at) }
        : undefined;
    },
    saveAccess(c) {
      db.prepare(
        "INSERT INTO ai_access (hash,grant_id,expires_at) VALUES (?,?,?)",
      ).run(c.hash, c.grantId, c.expiresAt);
    },
    apiKey(hash) {
      const row = db
        .prepare("SELECT grant_id FROM ai_api_keys WHERE hash=?")
        .get(hash);
      return row ? { hash, grantId: String(row.grant_id) } : undefined;
    },
    saveApiKey(key) {
      db.prepare("INSERT INTO ai_api_keys (hash,grant_id) VALUES (?,?)").run(
        key.hash,
        key.grantId,
      );
    },
  };
  return repository;
}
