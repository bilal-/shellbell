import { createNotificationService, type NotificationProvider } from "@shellbell/relay-core";
import { createCloudflareNotificationStore } from "../src/adapters/notification-store.js";

/** Retains the historical scenarios while all delivery policy runs in the shared service. */
export function createPushJobsHarness(
  storage: DurableObjectStorage,
  options: {
    computerFp: string;
    attentive(phone: string, now: number): boolean;
    schedule(): Promise<void>;
    provider: NotificationProvider;
    now(): number;
  },
) {
  const jobs = createNotificationService({
    ...options,
    randomId: () => crypto.randomUUID(),
    store: createCloudflareNotificationStore(storage, {
      ...options,
      randomId: () => crypto.randomUUID(),
    }),
    provider: options.provider,
  });
  return {
    ...jobs,
    async forgetPhone(phone: string) {
      await jobs.cancelPhone(phone);
      storage.sql.exec("DELETE FROM push_registrations WHERE phone_fp = ?", phone);
    },
  };
}
export type PushJobs = ReturnType<typeof createPushJobsHarness>;
