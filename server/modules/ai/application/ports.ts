import type {
  AiGrant,
  AuthorizationCode,
  AccessCredential,
  ApiKeyCredential,
} from "../domain/ai-authorization.ts";
import type { AiReceipt, AiOperation } from "../domain/ai-operation.ts";

export interface AiAuthorizationRepository {
  registeredRedirects(): string[];
  grants(memberId: string): AiGrant[];
  refresh(hash: string): { hash: string; grantId: string } | undefined;
  saveRefresh(credential: { hash: string; grantId: string }): void;
  removeRefresh(hash: string): void;
  grant(id: string): AiGrant | undefined;
  saveGrant(grant: AiGrant): void;
  removeRevokedGrant(id: string, deletedAt: number): boolean;
  code(hash: string): AuthorizationCode | undefined;
  saveCode(code: AuthorizationCode): void;
  removeCode(hash: string): void;
  access(hash: string): AccessCredential | undefined;
  saveAccess(access: AccessCredential): void;
  apiKey(hash: string): ApiKeyCredential | undefined;
  saveApiKey(key: ApiKeyCredential): void;
}

export interface AiOperationRepository {
  receipt(memberId: string, operationId: string): AiReceipt | undefined;
  saveReceipt(receipt: AiReceipt): void;
  addOperation(operation: AiOperation): void;
  operations(memberId: string): AiOperation[];
}
