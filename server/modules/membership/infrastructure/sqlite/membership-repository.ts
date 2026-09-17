import type { DatabaseSync } from "node:sqlite";
import type { MembershipRepository } from "../../application/ports.ts";
import type {
  Account,
  InvitationState,
  Member,
  Team,
} from "../../domain/membership.ts";

export function membershipRepository(db: DatabaseSync): MembershipRepository {
  const invitationSelect = `SELECT id, token_hash AS tokenHash, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, used_by AS usedBy FROM invitations`;
  return {
    team: () =>
      db.prepare("SELECT id, name FROM team WHERE id = 1").get() as unknown as
        Team | undefined,
    createTeam: (name) => {
      db.prepare("INSERT INTO team VALUES (1, ?)").run(name);
    },
    member: (id) =>
      db
        .prepare("SELECT id, name, email FROM members WHERE id = ?")
        .get(id) as unknown as Member | undefined,
    members: () =>
      db
        .prepare("SELECT id, name FROM members ORDER BY name, id")
        .all() as unknown as Pick<Member, "id" | "name">[],
    account: (email) =>
      db
        .prepare(
          "SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt FROM members WHERE email = ?",
        )
        .get(email) as unknown as Account | undefined,
    addAccount: (a) => {
      db.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?)").run(
        a.id,
        a.name,
        a.email,
        a.passwordHash,
        a.createdAt,
      );
    },
    session: (hash, now) =>
      db
        .prepare(
          "SELECT m.id, m.name, m.email FROM members m JOIN sessions s ON s.member_id = m.id WHERE s.token_hash = ? AND s.expires_at > ?",
        )
        .get(hash, now) as unknown as Member | undefined,
    addSession: (hash, id, expiresAt, now) => {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
        hash,
        id,
        expiresAt,
      );
    },
    deleteSession: (hash) => {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    },
    invitation: (id) =>
      db.prepare(`${invitationSelect} WHERE id = ?`).get(id) as unknown as
        InvitationState | undefined,
    invitationByToken: (hash) =>
      db
        .prepare(`${invitationSelect} WHERE token_hash = ?`)
        .get(hash) as unknown as InvitationState | undefined,
    invitations: (id) =>
      db
        .prepare(
          `${invitationSelect} WHERE created_by = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(id) as unknown as InvitationState[],
    saveInvitation: (s) => {
      db.prepare(
        `INSERT INTO invitations (id, token_hash, created_by, created_at, expires_at, revoked_at, used_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revoked_at = excluded.revoked_at, used_by = excluded.used_by`,
      ).run(
        s.id,
        s.tokenHash,
        s.createdBy,
        s.createdAt,
        s.expiresAt,
        s.revokedAt,
        s.usedBy,
      );
    },
  };
}
