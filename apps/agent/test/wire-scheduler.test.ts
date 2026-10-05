import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WireScheduler, type WireSchedulerOptions } from "../src/wire-scheduler.js";

function fixture(rate = 3) {
  let now = 0;
  const errors: unknown[] = [];
  const scheduler = new WireScheduler({
    now: () => now,
    maxFramesPerSecond: rate,
    onError: (error) => errors.push(error),
  });
  return { scheduler, errors, at: (value: number) => (now = value) };
}

describe("WireScheduler", () => {
  it.each(["producer", "observer"])(
    "contains rejected promises returned by the %s without async admission",
    (source) => {
      // Isolate process-level rejection events from Vitest's own unhandled-error listeners.
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import { WireScheduler } from ${JSON.stringify(new URL("../src/wire-scheduler.ts", import.meta.url).href)};
      let now = 0;
      let badCalls = 0;
      let sent = 0;
      const errors = [];
      const escaped = [];
      process.on("unhandledRejection", (error) => escaped.push(error.message));
      const scheduler = new WireScheduler({
        now: () => now,
        maxFramesPerSecond: 2,
        onError: async (error) => {
          errors.push(error.name);
          if (${JSON.stringify(source)} === "observer") throw new Error("observer rejection");
        },
      });
      scheduler.register("invalid", () => {
        badCalls++;
        if (${JSON.stringify(source)} === "producer") return Promise.reject(new Error("producer rejection"));
        throw new Error("uncertain admission");
      });
      scheduler.register("healthy", () => { sent++; return true; });
      now = 1000;
      const first = scheduler.pump();
      const immediate = { first, sent, badCalls, errors: [...errors], exhausted: scheduler.pump() };
      await new Promise(setImmediate);
      const afterSettlement = scheduler.pump();
      now = 2000;
      const later = scheduler.pump();
      console.log(JSON.stringify({ immediate, escaped, afterSettlement, later, sent, badCalls, errors }));
    `,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      const result = JSON.parse(output);
      expect(result.immediate).toEqual({
        first: 1,
        sent: 1,
        badCalls: 1,
        errors: [source === "producer" ? "TypeError" : "Error"],
        exhausted: 0,
      });
      expect(result.escaped).toEqual([]);
      expect(result.afterSettlement).toBe(0);
      expect(result.later).toBe(2);
      expect(result.sent).toBe(3);
      expect(result.badCalls).toBe(1);
      expect(result.errors).toEqual([source === "producer" ? "TypeError" : "Error"]);
    },
  );

  for (const source of ["producer", "observer"] as const) {
    it.each(["getter", "method"])(
      `contains a throwing thenable %s from the ${source} without invoking then inline`,
      async (kind) => {
        let now = 0;
        const order: string[] = [];
        const errors: unknown[] = [];
        const thenable = {
          // biome-ignore lint/suspicious/noThenProperty: deliberately exercise hostile callback thenables.
          get then() {
            if (kind === "getter") throw new Error("invalid then getter");
            return () => {
              order.push("then");
              throw new Error("invalid then method");
            };
          },
        };
        const scheduler = new WireScheduler({
          now: () => now,
          maxFramesPerSecond: 2,
          onError: (error) => {
            errors.push(error);
            if (source === "observer") return thenable;
          },
        });
        scheduler.register("invalid", (() => {
          order.push("invalid");
          if (source === "producer") return thenable;
          throw new Error("uncertain send");
        }) as unknown as () => boolean);
        scheduler.register("healthy", () => {
          order.push("healthy");
          return true;
        });
        now = 1_000;
        expect(scheduler.pump()).toBe(1);
        expect(order).toEqual(["invalid", "healthy"]);
        expect(errors).toHaveLength(1);
        if (source === "producer") expect(errors[0]).toBeInstanceOf(TypeError);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(order).toEqual(
          kind === "method" ? ["invalid", "healthy", "then"] : ["invalid", "healthy"],
        );
        expect(errors).toHaveLength(1);
        expect(scheduler.pump()).toBe(0);
        now = 2_000;
        expect(scheduler.pump()).toBe(2);
        expect(order.slice(-2)).toEqual(["healthy", "healthy"]);
      },
    );
  }

  it("shares one-token refills fairly between actual legacy and bounded sends", () => {
    let now = 0;
    const sent: string[] = [];
    const scheduler = new WireScheduler({ now: () => now, maxFramesPerSecond: 1 });
    scheduler.register("legacy", () => {
      sent.push("legacy");
      return true;
    });
    scheduler.register("bounded", () => {
      sent.push("bounded");
      return true;
    });
    expect(scheduler.pump()).toBe(0);
    now = 1_000;
    expect(scheduler.pump()).toBe(1);
    now = 2_000;
    expect(scheduler.pump()).toBe(1);
    expect(sent).toEqual(["legacy", "bounded"]);
  });

  it("starts empty and caps default accepted envelopes at 40 despite blocked attempts and long idle", () => {
    let now = 0;
    let blocked = 0;
    let sent = 0;
    const scheduler = new WireScheduler({ now: () => now });
    scheduler.register("blocked", () => {
      blocked++;
      return false;
    });
    scheduler.register("ready", () => {
      sent++;
      return true;
    });
    expect(scheduler.nextBudgetAt()).toBe(25);
    expect(scheduler.pump()).toBe(0);
    expect(sent).toBe(0);
    now = 1_000;
    expect(scheduler.pump()).toBe(40);
    expect(sent).toBe(40);
    expect(blocked).toBe(1);
    expect(scheduler.pump()).toBe(0);
    now = 100_000;
    expect(scheduler.pump()).toBe(40);
    expect(sent).toBe(80);
    expect(blocked).toBe(2);
  });

  it("continues one-token rounds across three mixed-mode links", () => {
    const { scheduler, at } = fixture(1);
    const sent: string[] = [];
    for (const label of ["legacy", "history-chunk", "live-chunk"])
      scheduler.register(label, () => {
        sent.push(label);
        return true;
      });
    for (const time of [1_000, 2_000, 3_000, 4_000, 5_000, 6_000]) {
      at(time);
      expect(scheduler.pump()).toBe(1);
    }
    expect(sent).toEqual([
      "legacy",
      "history-chunk",
      "live-chunk",
      "legacy",
      "history-chunk",
      "live-chunk",
    ]);
  });

  it("runs successful producers once per round and skips a refusal for the rest of that pump", () => {
    const { scheduler, at } = fixture(5);
    const attempts: string[] = [];
    for (const label of ["blocked", "legacy", "chunk"])
      scheduler.register(label, () => {
        attempts.push(label);
        return label !== "blocked";
      });
    at(1_000);
    expect(scheduler.pump()).toBe(5);
    expect(attempts).toEqual(["blocked", "legacy", "chunk", "legacy", "chunk", "legacy"]);
    at(1_200);
    expect(scheduler.pump()).toBe(1);
    expect(attempts.at(-1)).toBe("chunk");
  });

  it("refunds all refusals and retries readiness only on a later explicit pump", () => {
    const { scheduler, at } = fixture(2);
    let ready = false;
    const attempts: string[] = [];
    scheduler.register("first", () => {
      attempts.push("first");
      return false;
    });
    scheduler.register("second", () => {
      attempts.push("second");
      return ready;
    });
    at(1_000);
    expect(attempts).toEqual([]);
    expect(scheduler.nextBudgetAt()).toBeNull();
    expect(attempts).toEqual([]);
    expect(scheduler.pump()).toBe(0);
    expect(attempts).toEqual(["first", "second"]);
    expect(scheduler.nextBudgetAt()).toBeNull();
    ready = true;
    expect(scheduler.pump()).toBe(2);
    expect(attempts).toEqual(["first", "second", "first", "second", "second"]);
  });

  it("preserves partial refill and clamps backward clock motion without minting twice", () => {
    const { scheduler, at } = fixture(4);
    let sent = 0;
    scheduler.register("one", () => {
      sent++;
      return true;
    });
    at(125);
    expect(scheduler.pump()).toBe(0);
    expect(scheduler.nextBudgetAt()).toBe(250);
    at(100);
    expect(scheduler.nextBudgetAt()).toBe(250);
    at(250);
    expect(scheduler.pump()).toBe(1);
    at(0);
    expect(scheduler.pump()).toBe(0);
    expect(scheduler.nextBudgetAt()).toBe(500);
    at(375);
    expect(scheduler.pump()).toBe(0);
    expect(scheduler.nextBudgetAt()).toBe(500);
    at(500);
    expect(scheduler.pump()).toBe(1);
    expect(sent).toBe(2);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid rate %s",
    (rate) => {
      expect(() => new WireScheduler({ now: () => 0, maxFramesPerSecond: rate })).toThrow(
        RangeError,
      );
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite clock %s without corrupting later budget",
    (invalid) => {
      expect(() => new WireScheduler({ now: () => invalid })).toThrow(RangeError);
      const { scheduler, at } = fixture(1);
      let sent = 0;
      scheduler.register("one", () => {
        sent++;
        return true;
      });
      at(invalid);
      expect(() => scheduler.pump()).toThrow(RangeError);
      expect(() => scheduler.nextBudgetAt()).toThrow(RangeError);
      at(1_000);
      expect(scheduler.pump()).toBe(1);
      expect(sent).toBe(1);
    },
  );

  it("copies options and rejects an empty registration key", () => {
    let now = 0;
    const errors: unknown[] = [];
    const options: WireSchedulerOptions = {
      now: () => now,
      maxFramesPerSecond: 1,
      onError: (error) => errors.push(error),
    };
    const scheduler = new WireScheduler(options);
    options.now = () => NaN;
    options.maxFramesPerSecond = 9;
    options.onError = () => {
      throw new Error("wrong observer");
    };
    expect(() => scheduler.register("", () => true)).toThrow(RangeError);
    const failure = new Error("uncertain admission");
    scheduler.register("broken", () => {
      throw failure;
    });
    now = 1_000;
    expect(scheduler.pump()).toBe(0);
    expect(errors).toEqual([failure]);
    let sent = 0;
    scheduler.register("healthy", () => {
      sent++;
      return true;
    });
    expect(scheduler.pump()).toBe(0);
    now = 2_000;
    expect(scheduler.pump()).toBe(1);
    expect(sent).toBe(1);
  });

  it("keeps same-key replacement despite obsolete cleanup and releases the current callback", () => {
    const { scheduler, at } = fixture();
    const attempts: string[] = [];
    const oldCleanup = scheduler.register("link", () => {
      attempts.push("old");
      return false;
    });
    const cleanup = scheduler.register("link", () => {
      attempts.push("new");
      return false;
    });
    oldCleanup();
    at(1_000);
    expect(scheduler.pump()).toBe(0);
    expect(attempts).toEqual(["new"]);
    cleanup();
    cleanup();
    oldCleanup();
    expect(scheduler.nextBudgetAt()).toBeNull();
    expect(scheduler.pump()).toBe(0);
    expect(attempts).toEqual(["new"]);
  });

  it("removes self without preventing other producers from using remaining tokens", () => {
    const { scheduler, at } = fixture();
    const sent: string[] = [];
    const cleanup = scheduler.register("self", () => {
      sent.push("self");
      cleanup();
      return true;
    });
    scheduler.register("other", () => {
      sent.push("other");
      return true;
    });
    at(1_000);
    expect(scheduler.pump()).toBe(3);
    expect(sent).toEqual(["self", "other", "other"]);
  });

  it.each(["remove", "replace"])(
    "skips a producer whose identity another callback will %s",
    (change) => {
      const { scheduler, at } = fixture();
      const attempts: string[] = [];
      const firstCleanup = scheduler.register("first", () => {
        attempts.push("first");
        firstCleanup();
        if (change === "remove") secondCleanup();
        else
          scheduler.register("second", () => {
            attempts.push("replacement");
            return false;
          });
        scheduler.register("new", () => {
          attempts.push("new");
          return false;
        });
        return false;
      });
      const secondCleanup = scheduler.register("second", () => {
        attempts.push("obsolete");
        return true;
      });
      scheduler.register("healthy", () => {
        attempts.push("healthy");
        return false;
      });
      at(1_000);
      expect(scheduler.pump()).toBe(0);
      expect(attempts).toEqual(["first", "healthy"]);
      secondCleanup();
      expect(scheduler.pump()).toBe(0);
      expect(attempts.slice(2)).toEqual(
        change === "replace" ? ["replacement", "new", "healthy"] : ["new", "healthy"],
      );
    },
  );

  it("reserves before callbacks and freezes refill across reentrant budget queries and pumps", () => {
    let now = 0;
    let clockReads = 0;
    let calls = 0;
    const hints: (number | null)[] = [];
    const scheduler = new WireScheduler({
      now: () => {
        clockReads++;
        return now;
      },
      maxFramesPerSecond: 1,
    });
    scheduler.register("one", () => {
      calls++;
      now += 1_000;
      hints.push(scheduler.nextBudgetAt());
      expect(scheduler.pump()).toBe(0);
      return true;
    });
    now = 1_000;
    const before = clockReads;
    expect(scheduler.pump()).toBe(1);
    expect(clockReads - before).toBe(1);
    expect(calls).toBe(1);
    expect(hints).toEqual([2_000]);
    expect(scheduler.pump()).toBe(1);
    expect(calls).toBe(2);
    expect(hints).toEqual([2_000, 3_000]);
  });

  it.each([true, false])(
    "clear during a callback returning %s stops that pump and preserves reservation accounting",
    (accepted) => {
      const { scheduler, at } = fixture(1);
      const attempts: string[] = [];
      const cleanup = scheduler.register("one", () => {
        attempts.push("old");
        scheduler.clear();
        scheduler.register("one", () => {
          attempts.push("new");
          return true;
        });
        return accepted;
      });
      scheduler.register("obsolete", () => {
        attempts.push("obsolete");
        return true;
      });
      at(1_000);
      expect(scheduler.pump()).toBe(accepted ? 1 : 0);
      expect(attempts).toEqual(["old"]);
      cleanup();
      expect(scheduler.pump()).toBe(accepted ? 0 : 1);
      expect(attempts).toEqual(accepted ? ["old"] : ["old", "new"]);
      at(2_000);
      expect(scheduler.pump()).toBe(1);
      expect(attempts.at(-1)).toBe("new");
    },
  );

  it("refunds a reentrant refusal without refilling from its advanced clock", () => {
    const { scheduler, at } = fixture(1);
    const attempts: string[] = [];
    const hints: (number | null)[] = [];
    const nested: number[] = [];
    scheduler.register("blocked", () => {
      attempts.push("blocked");
      at(100_000);
      hints.push(scheduler.nextBudgetAt());
      nested.push(scheduler.pump());
      return false;
    });
    scheduler.register("ready", () => {
      attempts.push("ready");
      return true;
    });
    at(1_000);
    expect(scheduler.pump()).toBe(1);
    expect(attempts).toEqual(["blocked", "ready"]);
    expect(hints).toEqual([2_000]);
    expect(nested).toEqual([0]);
    expect(scheduler.pump()).toBe(1);
    expect(attempts).toEqual(["blocked", "ready", "blocked", "ready"]);
  });

  it("stops on error-observer clear and leaves its new registration for a later pump", () => {
    let now = 0;
    const attempts: string[] = [];
    const scheduler = new WireScheduler({
      now: () => now,
      maxFramesPerSecond: 2,
      onError: () => {
        scheduler.clear();
        scheduler.register("same", () => {
          attempts.push("new");
          return true;
        });
      },
    });
    const cleanup = scheduler.register("same", () => {
      attempts.push("old");
      throw new Error("uncertain send");
    });
    scheduler.register("obsolete", () => {
      attempts.push("obsolete");
      return true;
    });
    now = 1_000;
    expect(scheduler.pump()).toBe(0);
    expect(attempts).toEqual(["old"]);
    cleanup();
    expect(scheduler.pump()).toBe(1);
    expect(attempts).toEqual(["old", "new"]);
    expect(scheduler.pump()).toBe(0);
  });

  it("clear releases all producers without restoring spent tokens", () => {
    const { scheduler, at } = fixture(1);
    let sent = 0;
    scheduler.register("old", () => {
      sent++;
      return true;
    });
    at(1_000);
    expect(scheduler.pump()).toBe(1);
    scheduler.clear();
    expect(scheduler.nextBudgetAt()).toBeNull();
    expect(scheduler.pump()).toBe(0);
    scheduler.register("new", () => {
      sent++;
      return true;
    });
    expect(scheduler.nextBudgetAt()).toBe(2_000);
    expect(scheduler.pump()).toBe(0);
    at(2_000);
    expect(scheduler.pump()).toBe(1);
    expect(sent).toBe(2);
  });

  it("contains producer and observer throws while conservatively charging and preserving replacements", () => {
    let now = 0;
    const attempts: string[] = [];
    const failure = new Error("admission uncertain");
    const errors: unknown[] = [];
    const scheduler = new WireScheduler({
      now: () => now,
      maxFramesPerSecond: 3,
      onError: (error) => {
        errors.push(error);
        throw new Error("observer failed");
      },
    });
    scheduler.register("broken", () => {
      attempts.push("broken");
      scheduler.register("broken", () => {
        attempts.push("replacement");
        return true;
      });
      throw failure;
    });
    scheduler.register("healthy", () => {
      attempts.push("healthy");
      return true;
    });
    now = 1_000;
    expect(scheduler.pump()).toBe(2);
    expect(attempts).toEqual(["broken", "healthy", "healthy"]);
    expect(errors).toEqual([failure]);
    expect(scheduler.pump()).toBe(0);
    now = 2_000;
    expect(scheduler.pump()).toBe(3);
    expect(attempts.slice(3)).toEqual(["replacement", "healthy", "replacement"]);
  });

  it.each([undefined, null, 0, 1, "true", {}, Promise.resolve(true)])(
    "treats nonboolean return %s as one uncertain admission, not success",
    (result) => {
      const { scheduler, at, errors } = fixture(2);
      const attempts: string[] = [];
      scheduler.register("invalid", (() => {
        attempts.push("invalid");
        return result;
      }) as () => boolean);
      scheduler.register("healthy", () => {
        attempts.push("healthy");
        return true;
      });
      at(1_000);
      expect(scheduler.pump()).toBe(1);
      expect(attempts).toEqual(["invalid", "healthy"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(TypeError);
      expect(scheduler.pump()).toBe(0);
      at(2_000);
      expect(scheduler.pump()).toBe(2);
      expect(attempts).toEqual(["invalid", "healthy", "healthy", "healthy"]);
    },
  );
});
