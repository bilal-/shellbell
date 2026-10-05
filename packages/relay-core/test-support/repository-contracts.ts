import type { NotificationHarness } from "./notification-store-contract.js";

/** Fault injection stays in adapter tests; production ports describe only runtime work. */
export interface RecoveryHarness extends NotificationHarness {
  corrupt(field: "dueAt" | "expiresAt" | "sendCount"): void;
  repair(): void;
  revoke(): Promise<void>;
}
export type Equal = (actual: unknown, expected: unknown) => void;
export interface RecoveryCase {
  name: string;
  run(h: RecoveryHarness, equal: Equal): Promise<void>;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
