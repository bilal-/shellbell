import type { WakeupScheduler } from "@shellbell/relay-core";

/** Serialize alarm persistence; a rejection must not poison later updates. */
export function createCloudflareScheduler(
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">,
  now: () => number = () => Date.now(),
): WakeupScheduler {
  let tail: Promise<void> = Promise.resolve();
  return {
    replace(deadline) {
      const update = async () => {
        const current = await storage.getAlarm();
        if (deadline === null) await storage.deleteAlarm();
        else {
          const target = Math.max(now() + 1000, deadline);
          if (current !== null && deadline <= current && current <= target) return;
          await storage.setAlarm(target);
        }
      };
      const result = tail.then(update, update);
      tail = result;
      return result;
    },
  };
}
