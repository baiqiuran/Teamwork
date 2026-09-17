import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { AuthorizationError } from "../../domain/ai-authorization.ts";
export function toolResult(work: () => object) {
  try {
    const result = work();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    if (
      error instanceof DomainError ||
      error instanceof AuthorizationError ||
      error instanceof z.ZodError
    ) {
      const details = error instanceof DomainError ? error.details : undefined;
      const result = {
        error: {
          code: error instanceof z.ZodError ? "invalid" : error.code,
          message:
            error instanceof z.ZodError
              ? "请检查输入格式与长度限制。"
              : error.message,
          details,
        },
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
    const result = {
      error: {
        code: "unavailable",
        message: "服务暂时不可用，请使用同一 operationId 重试。",
      },
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
}
