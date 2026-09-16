export type ErrorCode =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "gone";
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
