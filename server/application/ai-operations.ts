import { canonical, type AiOperation } from "../domain/ai-operation.ts";
import { DomainError, isValidationError } from "../domain/errors.ts";
import {
  AuthorizationError,
  type Capability,
} from "../domain/ai-authorization.ts";
import type { AiAuthorization } from "./ai-authorization.ts";
import type { AiOperationRepository, Runtime, Security } from "./ports.ts";
export type AiAccess = { token: string; resource: string };
export class AiOperations {
  constructor(
    private readonly auth: AiAuthorization,
    private readonly repo: AiOperationRepository,
    private readonly runtime: Runtime,
    private readonly security: Security,
  ) {}
  invalidInput(access: AiAccess, tool: string) {
    const { member, grant } = this.auth.authenticate(
      access.token,
      access.resource,
    );
    this.repo.addOperation({
      id: this.runtime.id(),
      memberId: member.id,
      grantId: grant.id,
      clientId: grant.clientId,
      tool,
      at: this.runtime.now(),
      outcome: "failure",
      objectId: null,
      errorCode: "invalid",
    });
  }
  run(
    access: AiAccess,
    tool: string,
    input: { operationId: string; id?: string },
    scopes: Capability[],
    action: (memberId: string) => {
      result: Record<string, unknown>;
      objectId: string;
    },
    extraScopes?: (memberId: string) => Capability[],
  ) {
    const actor = this.auth.authenticate(access.token, access.resource);
    const fingerprint = this.security.digest(canonical(input));
    const event = (
      outcome: AiOperation["outcome"],
      objectId: string | null,
      errorCode: string | null,
    ) =>
      this.repo.addOperation({
        id: this.runtime.id(),
        memberId: actor.member.id,
        grantId: actor.grant.id,
        clientId: actor.grant.clientId,
        tool,
        at: this.runtime.now(),
        outcome,
        objectId,
        errorCode,
      });
    try {
      return this.runtime.transaction(() =>
        this.auth.authorized(access.token, access.resource, scopes, () => {
          const previous = this.repo.receipt(
            actor.member.id,
            input.operationId,
          );
          if (previous) {
            if (previous.tool !== tool || previous.fingerprint !== fingerprint)
              throw new DomainError(
                "operation-id-conflict",
                "操作标识已用于其他参数，请给出新的操作标识。",
              );
            this.auth.authorized(
              access.token,
              access.resource,
              previous.scopes,
              () => true,
            );
            event(
              "replay",
              typeof previous.result.objectId === "string"
                ? previous.result.objectId
                : null,
              null,
            );
            return { ...previous.result, replayed: true };
          }
          const required = [
            ...new Set([...scopes, ...(extraScopes?.(actor.member.id) ?? [])]),
          ];
          this.auth.authorized(
            access.token,
            access.resource,
            required,
            () => true,
          );
          const { result, objectId } = action(actor.member.id),
            stored = { ...result, objectId, executedAt: this.runtime.now() };
          this.repo.saveReceipt({
            memberId: actor.member.id,
            operationId: input.operationId,
            tool,
            fingerprint,
            grantId: actor.grant.id,
            scopes: required,
            result: stored,
          });
          event("success", objectId, null);
          return { ...stored, replayed: false };
        }),
      );
    } catch (error) {
      event(
        "failure",
        input.id &&
          ((error instanceof DomainError &&
            ["version-conflict", "history-locked", "archived"].includes(
              error.code,
            )) ||
            isValidationError(error))
          ? input.id
          : null,
        error instanceof DomainError || error instanceof AuthorizationError
          ? error.code
          : isValidationError(error)
            ? "invalid"
            : "unavailable",
      );
      throw error;
    }
  }
}
