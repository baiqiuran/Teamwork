export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
