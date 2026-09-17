export interface Runtime {
  now(): number;
  id(): string;
  /** All repository writes in the callback commit or roll back together. Callbacks must be synchronous. */
  transaction<T>(work: () => T): T;
}

export interface Security {
  challenge(value: string): string;
  secret(): string;
  digest(value: string): string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  dummyPasswordHash: string;
}
