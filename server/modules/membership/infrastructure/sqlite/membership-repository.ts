import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../../../shared/domain/errors.ts";
import type { MembershipRepository } from "../../application/ports.ts";
import { teamNameKey } from "../../../../shared/domain/team-name.ts";
import type {
  Account,
  InvitationState,
  Member,
  MemberSummary,
  Team,
} from "../../domain/membership.ts";

export function membershipRepository(db: DatabaseSync): MembershipRepository {
  const invitationSelect = `SELECT id, token_hash AS tokenHash, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, used_by AS usedBy FROM invitations`;
  return {
    hasTeams: () => Boolean(db.prepare("SELECT 1 FROM team LIMIT 1").get()),
    team: (id) =>
      db
        .prepare("SELECT id, name FROM team WHERE id = ?")
        .get(id) as unknown as Team | undefined,
    createTeam: (name) => {
      const result = db
        .prepare(
          "INSERT INTO team (name, name_key) VALUES (?, ?) ON CONFLICT(name_key) DO NOTHING",
        )
        .run(name, teamNameKey(name));
      if (!result.changes)
        throw new DomainError("conflict", "团队名称已被使用，请更换名称。");
      return { id: Number(result.lastInsertRowid), name };
    },
    member: (id) =>
      db
        .prepare(
          "SELECT id, name, email, team_id AS teamId FROM members WHERE id = ?",
        )
        .get(id) as unknown as Member | undefined,
    members: (memberId) =>
      db
        .prepare(
          `SELECT id, name, created_at AS joinedAt FROM members
           WHERE team_id = (SELECT team_id FROM members WHERE id = ?)
           ORDER BY name, id`,
        )
        .all(memberId) as unknown as MemberSummary[],
    account: (email) =>
      db
        .prepare(
          "SELECT id, name, email, team_id AS teamId, password_hash AS passwordHash, created_at AS createdAt FROM members WHERE email = ?",
        )
        .get(email) as unknown as Account | undefined,
    addAccount: (a) => {
      db.prepare(
        "INSERT INTO members (id, name, email, password_hash, created_at, team_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(a.id, a.name, a.email, a.passwordHash, a.createdAt, a.teamId);
    },
    session: (hash, now) =>
      db
        .prepare(
          "SELECT m.id, m.name, m.email, m.team_id AS teamId FROM members m JOIN sessions s ON s.member_id = m.id WHERE s.token_hash = ? AND s.expires_at > ?",
        )
        .get(hash, now) as unknown as Member | undefined,
    addSession: (hash, id, expiresAt, now) => {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      db.prepare(
        "INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)",
      ).run(hash, id, expiresAt);
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
