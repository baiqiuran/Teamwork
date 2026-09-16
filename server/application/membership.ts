import { DomainError } from "../domain/errors.ts";
import { Invitation, WEEK, type Member } from "../domain/membership.ts";
import type { MembershipRepository, Runtime, Security } from "./ports.ts";

export interface Credentials {
  email: string;
  password: string;
}
export interface Registration extends Credentials {
  name: string;
}
export class Membership {
  constructor(
    private readonly repo: MembershipRepository,
    private readonly runtime: Runtime,
    private readonly security: Security,
    private readonly setupKey: string,
  ) {}
  team() {
    return this.repo.team();
  }
  authenticate(token: string) {
    const member = this.repo.session(
      this.security.digest(token),
      this.runtime.now(),
    );
    if (!member) throw new DomainError("unauthenticated", "请先登录。");
    return member;
  }
  private session(member: Member) {
    const token = this.security.secret(),
      at = this.runtime.now();
    this.repo.addSession(this.security.digest(token), member.id, at + WEEK, at);
    return {
      token,
      member: { id: member.id, name: member.name, email: member.email },
      team: this.team(),
    };
  }
  async setup(
    input: Registration & { teamName: string; setupKey: string },
    local: boolean,
  ) {
    if (this.team())
      throw new DomainError("conflict", "团队已经建立，请登录或使用邀请加入。");
    if (
      !local ||
      this.security.digest(input.setupKey) !==
        this.security.digest(this.setupKey)
    )
      throw new DomainError("forbidden", "请使用本机启动时提供的引导密钥。");
    const passwordHash = await this.security.hashPassword(input.password);
    return this.runtime.transaction(() => {
      if (this.team()) throw new DomainError("conflict", "团队已经建立。");
      const member = {
        id: this.runtime.id(),
        name: input.name,
        email: input.email,
      };
      this.repo.createTeam(input.teamName);
      this.repo.addAccount({
        ...member,
        passwordHash,
        createdAt: this.runtime.now(),
      });
      return this.session(member);
    });
  }
  async login(input: Credentials, previousToken: string) {
    const member = this.repo.account(input.email);
    const valid = await this.security.verifyPassword(
      input.password,
      member?.passwordHash ?? this.security.dummyPasswordHash,
    );
    if (!member || !valid)
      throw new DomainError("unauthenticated", "邮箱或密码不正确。");
    return this.runtime.transaction(() => {
      this.logout(previousToken);
      return this.session(member);
    });
  }
  logout(token: string) {
    this.repo.deleteSession(this.security.digest(token));
  }
  invite(memberId: string) {
    const id = this.runtime.id(),
      token = this.security.secret(),
      at = this.runtime.now();
    const expiresAt = at + WEEK;
    this.repo.saveInvitation({
      id,
      tokenHash: this.security.digest(token),
      createdBy: memberId,
      createdAt: at,
      expiresAt,
      revokedAt: null,
      usedBy: null,
    });
    return {
      invitation: { id, expiresAt },
      token,
      joinPath: `/join#invite=${token}`,
    };
  }
  invitations(memberId: string) {
    return this.repo
      .invitations(memberId)
      .map((s) => ({
        id: s.id,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        status: new Invitation(s).status(this.runtime.now()),
      }));
  }
  private availableInvitation(token: string) {
    const state = this.repo.invitationByToken(this.security.digest(token));
    if (!state)
      throw new DomainError(
        "gone",
        "邀请无效、已过期或已使用，请向团队成员索取新邀请。",
      );
    const invitation = new Invitation(state);
    invitation.assertAvailable(this.runtime.now());
    return invitation;
  }
  previewInvitation(token: string) {
    const { state } = this.availableInvitation(token);
    return {
      team: this.team(),
      invitedBy: this.repo.member(state.createdBy)!.name,
      expiresAt: state.expiresAt,
    };
  }
  revokeInvitation(id: string, memberId: string) {
    this.runtime.transaction(() => {
      const state = this.repo.invitation(id);
      if (!state) throw new DomainError("not-found", "未找到邀请。");
      const invitation = new Invitation(state);
      invitation.revoke(memberId, this.runtime.now());
      this.repo.saveInvitation(invitation.state);
    });
  }
  async join(input: Registration & { token: string }) {
    this.availableInvitation(input.token);
    const passwordHash = await this.security.hashPassword(input.password);
    return this.runtime.transaction(() => {
      const invitation = this.availableInvitation(input.token);
      if (this.repo.account(input.email))
        throw new DomainError("conflict", "此邮箱已注册，请直接登录。");
      const member = {
        id: this.runtime.id(),
        name: input.name,
        email: input.email,
      };
      this.repo.addAccount({
        ...member,
        passwordHash,
        createdAt: this.runtime.now(),
      });
      invitation.accept(member.id, this.runtime.now());
      this.repo.saveInvitation(invitation.state);
      return this.session(member);
    });
  }
}
