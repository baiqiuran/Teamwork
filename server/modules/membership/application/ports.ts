import type {
  Account,
  InvitationState,
  Member,
  MemberSummary,
  Team,
} from "../domain/membership.ts";

export interface MembershipRepository {
  hasTeams(): boolean;
  team(id: number): Team | undefined;
  createTeam(name: string): Team;
  member(id: string): Member | undefined;
  members(memberId: string): MemberSummary[];
  account(email: string): Account | undefined;
  addAccount(account: Account): void;
  session(tokenHash: string, now: number): Member | undefined;
  addSession(
    tokenHash: string,
    memberId: string,
    expiresAt: number,
    now: number,
  ): void;
  deleteSession(tokenHash: string): void;
  invitation(id: string): InvitationState | undefined;
  invitationByToken(tokenHash: string): InvitationState | undefined;
  invitations(memberId: string): InvitationState[];
  saveInvitation(invitation: InvitationState): void;
}
