import { DomainError } from "../../../shared/domain/errors.ts";
export const WEEK = 7 * 24 * 60 * 60 * 1000;
export interface Member {
  id: string;
  teamId: number;
  name: string;
  email: string;
}
export interface Account extends Member {
  passwordHash: string;
  createdAt: number;
}
export interface MemberSummary {
  id: string;
  name: string;
  joinedAt: number;
}
export interface Team {
  id: number;
  name: string;
}
export interface InvitationState {
  id: string;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  usedBy: string | null;
}
export class Invitation {
  constructor(readonly state: InvitationState) {}
  status(now: number) {
    return this.state.usedBy
      ? "used"
      : this.state.revokedAt !== null
        ? "revoked"
        : this.state.expiresAt <= now
          ? "expired"
          : "active";
  }
  assertAvailable(now: number) {
    if (this.status(now) !== "active")
      throw new DomainError(
        "gone",
        "邀请无效、已过期或已使用，请向团队成员索取新邀请。",
      );
  }
  accept(memberId: string, now: number) {
    this.assertAvailable(now);
    this.state.usedBy = memberId;
  }
  revoke(memberId: string, now: number) {
    if (this.state.createdBy !== memberId)
      throw new DomainError("forbidden", "只能撤销自己生成的邀请。");
    if (this.state.usedBy)
      throw new DomainError("conflict", "邀请已被接受，不能撤销成员资格。");
    this.state.revokedAt ??= now;
  }
}
