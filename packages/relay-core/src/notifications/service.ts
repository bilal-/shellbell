import type { CtrlMessageOf } from "@shellbell/protocol";
import type { NotificationStore } from "../ports/notification-store.js";
import { buildPushIntent } from "./intent.js";
import type { Claim, NotifyMessage } from "./models.js";
import type { NotificationProvider } from "./provider.js";

/** All methods except pump perform local persistence only, never provider I/O. */
export interface NotificationService {
  register(phoneFp: string, message: CtrlMessageOf<"push-token">): Promise<void>;
  enqueue(message: NotifyMessage): Promise<void>;
  cancelPhone(phoneFp: string): Promise<void>;
  /** Never run under the computer transition coordinator. */
  pump(): Promise<void>;
  nextDeadline(): Promise<number | null>;
}
export interface NotificationServiceOptions {
  store: NotificationStore;
  provider: NotificationProvider;
  computerFp: string;
  now(): number;
  randomId(): string;
  /** Persist the earliest wakeup, including claim recovery, before external I/O. */
  schedule(): Promise<void>;
}
export function createNotificationService(
  options: NotificationServiceOptions,
): NotificationService {
  const { store, provider, now } = options;
  let running: Promise<void> | null = null;
  const live = async (claims: readonly Claim[]) => {
    const current = await Promise.all(claims.map((claim) => store.isCurrent(claim, now())));
    return claims.filter((_, index) => current[index]);
  };
  const pass = async () => {
    try {
      await store.recover(now());
      const sends = await store.claimSends(now(), 10);
      await options.schedule();
      const dispatch = await live(sends);
      if (dispatch.length) {
        const messages = dispatch.map(({ job, token, registration }) =>
          buildPushIntent(
            {
              computerFp: options.computerFp,
              sessionId: job.sessionId!,
              kind: job.kind!,
              exitCode: job.exitCode ?? undefined,
              durationMs: job.durationMs ?? undefined,
              admittedAt: job.admittedAt,
              expiresAt: job.expiresAt,
              context: job.context,
            },
            {
              computerFp: options.computerFp,
              phoneFp: job.phoneFp,
              token,
              provider: registration.provider!,
              ...(registration.environment ? { environment: registration.environment } : {}),
              platform: registration.platform,
              features: registration.features,
            },
          ),
        );
        const outcomes = await provider.send(messages);
        for (const [index, claim] of dispatch.entries()) {
          await store.finishSend(
            claim,
            outcomes[index] ?? { status: "retryable", code: "invalid-response" },
            now(),
          );
        }
      }
      // Attention, registration, or time may have changed during awaited scheduling/I/O.
      await store.recover(now());
    } finally {
      await options.schedule();
    }
  };
  return {
    register: (phone, message) => store.register(phone, message, options.randomId()),
    enqueue: (message) => store.enqueue(message, now()),
    cancelPhone: (phone) => store.cancelPhone(phone),
    nextDeadline: () => store.nextDeadline(),
    pump() {
      if (running) return running;
      running = pass().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
