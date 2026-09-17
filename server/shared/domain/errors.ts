export type ErrorCode =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "gone";
export type AiErrorCode =
  | "operation-id-conflict"
  | "version-conflict"
  | "history-locked"
  | "archived"
  | "share-closed";
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode | AiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
import { z } from "zod";
export const isValidationError = (error: unknown): error is z.ZodError =>
  error instanceof z.ZodError;
