import type { WakeupScheduler } from "@shellbell/relay-core";
export interface NodeSchedulerOptions {
  read(): number | null;
  write(deadline: number | null): void;
  now(): number;
  /** Resolves after local maintenance; external delivery belongs to runtime tracking. */
  wakeup(): Promise<void>;
  report(error: unknown): void;
}
export function createNodeScheduler(
  options: NodeSchedulerOptions,
): WakeupScheduler & { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let revision = 0;
  let retryDeadline: number | null = null;
  let tail: Promise<void> = Promise.resolve();
  function arm(retryFloor = 0) {
    clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    const deadline = options.read() ?? retryDeadline;
    if (running || deadline === null) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        const due = options.read() ?? retryDeadline;
        if (due === null || stopped) return;
        if (due > options.now()) {
          arm();
          return;
        }
        running = true;
        let failed = false;
        const startedRevision = revision;
        // Retain the persisted deadline until the wakeup is admitted; recovery also
        // enumerates durable computers to cover a crash before the next reschedule.
        Promise.resolve()
          .then(() => options.write(null))
          .then(options.wakeup)
          .then(() => {
            retryDeadline = null;
          })
          .catch((error) => {
            failed = true;
            options.report(error);
            // Do not overwrite any newer schedule, including an intentional cancel.
            if (!stopped && revision === startedRevision) {
              retryDeadline = due;
              try {
                if (options.read() !== due) options.write(due);
              } catch (restoreError) {
                options.report(restoreError);
              }
            }
          })
          .finally(() => {
            running = false;
            arm(failed ? 1000 : 0);
          });
      },
      Math.min(2_147_483_647, Math.max(retryFloor, deadline - options.now())),
    );
    timer.unref();
  }
  return {
    replace(deadline) {
      const update = async () => {
        if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline < 0))
          throw new Error("Invalid deadline");
        const current = options.read();
        const target = deadline === null ? null : Math.max(options.now() + 1000, deadline);
        if (!(deadline !== null && current !== null && deadline <= current && current <= target!))
          options.write(target);
        revision++;
        retryDeadline = null;
        arm();
      };
      const result = tail.then(update, update);
      tail = result;
      return result;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
