import {
  createParamDecorator,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Membership } from "../../application/membership.ts";
import type { Member } from "../../domain/membership.ts";
import { DomainError } from "../../domain/errors.ts";
import { cookieToken } from "./context.ts";

const ANONYMOUS = Symbol("AnonymousAccess");
export const Anonymous = () => SetMetadata(ANONYMOUS, true);
type MemberRequest = Request & { member?: Member };

export class SessionGuard implements CanActivate {
  constructor(
    private readonly membership: Membership,
    private readonly reflector: Reflector,
  ) {}
  canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride(ANONYMOUS, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<MemberRequest>();
    request.member = this.membership.authenticate(cookieToken(request));
    return true;
  }
}
export const CurrentMember = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Member => {
    const member = context.switchToHttp().getRequest<MemberRequest>().member;
    if (!member) throw new DomainError("unauthenticated", "请先登录。");
    return member;
  },
);
