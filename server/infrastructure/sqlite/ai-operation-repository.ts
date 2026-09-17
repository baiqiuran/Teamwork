import type { DatabaseSync } from "node:sqlite";
import type { AiOperationRepository } from "../../application/ports.ts";
import type { AiOperation } from "../../domain/ai-operation.ts";
export function aiOperationRepository(db: DatabaseSync): AiOperationRepository {
  return {
    receipt(memberId, operationId) {
      const r = db
        .prepare(
          "SELECT * FROM ai_receipts WHERE member_id=? AND operation_id=?",
        )
        .get(memberId, operationId);
      return r
        ? {
            memberId,
            operationId,
            tool: String(r.tool),
            fingerprint: String(r.fingerprint),
            grantId: String(r.grant_id),
            scopes: JSON.parse(String(r.scopes)),
            result: JSON.parse(String(r.result)),
          }
        : undefined;
    },
    saveReceipt(r) {
      db.prepare(
        "INSERT INTO ai_receipts (member_id,operation_id,tool,fingerprint,grant_id,result,scopes) VALUES (?,?,?,?,?,?,?)",
      ).run(
        r.memberId,
        r.operationId,
        r.tool,
        r.fingerprint,
        r.grantId,
        JSON.stringify(r.result),
        JSON.stringify(r.scopes),
      );
    },
    addOperation(o) {
      db.prepare(
        "INSERT INTO ai_operations (id,member_id,grant_id,client_id,tool,object_id,at,outcome,error_code) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        o.id,
        o.memberId,
        o.grantId,
        o.clientId,
        o.tool,
        o.objectId,
        o.at,
        o.outcome,
        o.errorCode,
      );
    },
    operations(memberId) {
      return db
        .prepare(
          "SELECT * FROM ai_operations WHERE member_id=? ORDER BY at DESC,id",
        )
        .all(memberId)
        .map((r) => ({
          id: String(r.id),
          memberId,
          grantId: String(r.grant_id),
          clientId: String(r.client_id),
          tool: String(r.tool),
          objectId: r.object_id === null ? null : String(r.object_id),
          at: Number(r.at),
          outcome: r.outcome as AiOperation["outcome"],
          errorCode: r.error_code === null ? null : String(r.error_code),
        }));
    },
  };
}
