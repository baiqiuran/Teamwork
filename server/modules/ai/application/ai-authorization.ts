import {
  AuthorizationError,
  validateAuthorization,
  type Capability,
  type AiGrant,
} from "../domain/ai-authorization.ts";
import type { AiAuthorizationRepository } from "./ports.ts";
import type { MembershipRepository } from "../../membership/application/ports.ts";
import type { Runtime, Security } from "../../../shared/application/ports.ts";
import { beijingDate } from "../../../shared/domain/date.ts";

export class AiAuthorization {
  constructor(
    private readonly repo: AiAuthorizationRepository,
    private readonly members: MembershipRepository,
    private readonly runtime: Runtime,
    private readonly security: Security,
  ) {}
  describe(input: unknown, resource: string) {
    return validateAuthorization(
      input,
      resource,
      this.repo.registeredRedirects(),
    );
  }
  authorize(
    memberId: string,
    input: unknown,
    resource: string,
    scopes: Capability[],
    approve: boolean,
  ) {
    const validated = this.describe(input, resource),
      request = validated.request;
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", new URL(resource).origin);
    if (!approve) {
      redirect.searchParams.set("error", "access_denied");
      return { redirect: redirect.href };
    }
    if (!scopes.length || scopes.some((s) => !validated.scopes.includes(s)))
      throw new AuthorizationError("invalid_scope", "批准能力超出请求。");
    return this.runtime.transaction(() => {
      if (!this.members.member(memberId))
        throw new AuthorizationError("access_denied", "成员不可用。", 403);
      const grant = {
        id: this.runtime.id(),
        memberId,
        clientId: request.client_id,
        resource,
        scopes: [...new Set(scopes)],
        createdAt: this.runtime.now(),
        lastUsedAt: this.runtime.now(),
        revokedAt: null,
      };
      this.repo.saveGrant(grant);
      const code = this.security.secret();
      this.repo.saveCode({
        hash: this.security.digest(code),
        grantId: grant.id,
        redirectUri: request.redirect_uri,
        challenge: request.code_challenge,
        expiresAt: this.runtime.now() + 120000,
      });
      redirect.searchParams.set("code", code);
      return { redirect: redirect.href };
    });
  }
  exchange(input: {
    code: string;
    code_verifier: string;
    client_id: string;
    redirect_uri: string;
    resource: string;
  }) {
    return this.runtime.transaction(() => {
      const code = this.repo.code(this.security.digest(input.code));
      const grant = code && this.repo.grant(code.grantId);
      if (
        !code ||
        !grant ||
        grant.revokedAt !== null ||
        code.expiresAt <= this.runtime.now() ||
        input.client_id !== grant.clientId ||
        input.redirect_uri !== code.redirectUri ||
        input.resource !== grant.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier) ||
        this.security.challenge(input.code_verifier) !== code.challenge ||
        !this.members.member(grant.memberId)
      )
        throw new AuthorizationError("invalid_grant", "授权码或绑定信息无效。");
      this.repo.removeCode(code.hash);
      return this.issueTokens(grant);
    });
  }
  private issueTokens(grant: AiGrant) {
    const token = this.security.secret(),
      refresh = this.security.secret();
    this.repo.saveAccess({
      hash: this.security.digest(token),
      grantId: grant.id,
      expiresAt: this.runtime.now() + 900000,
    });
    this.repo.saveRefresh({
      hash: this.security.digest(refresh),
      grantId: grant.id,
    });
    this.repo.saveGrant({ ...grant, lastUsedAt: this.runtime.now() });
    return {
      access_token: token,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 900,
      scope: grant.scopes.join(" "),
    };
  }
  refresh(input: {
    refresh_token: string;
    client_id: string;
    resource: string;
  }) {
    return this.runtime.transaction(() => {
      const credential = this.repo.refresh(
        this.security.digest(input.refresh_token),
      );
      const grant = credential && this.repo.grant(credential.grantId);
      if (
        !credential ||
        !grant ||
        grant.revokedAt !== null ||
        grant.clientId !== input.client_id ||
        grant.resource !== input.resource ||
        !this.members.member(grant.memberId)
      )
        throw new AuthorizationError("invalid_grant", "刷新凭证或授权无效。");
      this.repo.removeRefresh(credential.hash);
      return this.issueTokens(grant);
    });
  }
  connections(memberId: string) {
    return this.repo.grants(memberId).map((grant) => ({
      id: grant.id,
      client: grant.clientId,
      scopes: grant.scopes,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      revokedAt: grant.revokedAt,
    }));
  }
  revoke(memberId: string, id: string) {
    return this.runtime.transaction(() => {
      const grant = this.repo.grant(id);
      if (!grant || grant.memberId !== memberId)
        throw new AuthorizationError("not_found", "未找到连接。", 404);
      if (grant.revokedAt === null)
        this.repo.saveGrant({ ...grant, revokedAt: this.runtime.now() });
      return { ok: true };
    });
  }
  authorized<T>(
    token: string,
    resource: string,
    scopes: Capability[],
    execute: (actor: {
      grant: AiGrant;
      member: { id: string; name: string };
    }) => T,
  ): T {
    const actor = this.authenticate(token, resource);
    if (scopes.some((scope) => !actor.grant.scopes.includes(scope)))
      throw new AuthorizationError(
        "insufficient_scope",
        "未授予所需能力。",
        403,
      );
    return execute(actor);
  }
  authenticate(token: string, resource: string) {
    const credential = this.repo.access(this.security.digest(token));
    const grant = credential && this.repo.grant(credential.grantId);
    const member = grant && this.members.member(grant.memberId);
    if (
      !credential ||
      credential.expiresAt <= this.runtime.now() ||
      !grant ||
      grant.revokedAt !== null ||
      grant.resource !== resource ||
      !member
    )
      throw new AuthorizationError("invalid_token", "请重新连接并授权。", 401);
    this.repo.saveGrant({ ...grant, lastUsedAt: this.runtime.now() });
    return { grant, member: { id: member.id, name: member.name } };
  }
  context(token: string, resource: string) {
    const { grant, member } = this.authenticate(token, resource),
      now = this.runtime.now();
    return {
      member,
      scopes: grant.scopes,
      time: new Date(now).toISOString(),
      date: beijingDate(now),
      timeZone: "Asia/Shanghai",
      limits: {
        titleCharacters: 100,
        entryCharacters: 10000,
        entriesPerDiary: 50,
        attachmentsPerEntry: 10,
        historyRule: "已提交日报仅首次提交当天可改；日期按服务器北京时间。",
      },
    };
  }
}
