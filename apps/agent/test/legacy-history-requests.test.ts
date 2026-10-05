import {
  encodeCbor,
  FRAME_LIMITS,
  type InnerMessageOf,
  InnerMessageSchema,
  MAX_PAIRINGS,
  STREAM_LIMITS,
} from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { SessionGone } from "../src/backends/types.js";
import { LegacyHistoryRequests } from "../src/legacy-history-requests.js";
import { WireScheduler } from "../src/wire-scheduler.js";

const request = (reqId = "r1", sessionId = "iterm2:S"): InnerMessageOf<"history.get"> => ({
  type: "history.get",
  reqId,
  sessionId,
  before: 5,
  count: 2,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const page = (text = "hello") => ({ lines: [{ r: [{ t: text }] }], oldestAvailable: 0 });
const failed = (reqId: string, error: string) => ({ type: "ack", reqId, ok: false, error });

it("deduplicates active IDs and bounds owner slots and unresolved native reads", async () => {
  const reads = new Map<string, ReturnType<typeof deferred<ReturnType<typeof page>>>>();
  const called: string[] = [];
  const replies = new LegacyHistoryRequests({
    read: (sid, before, count) => {
      called.push(`${sid}:${before}:${count}`);
      const pending = deferred<ReturnType<typeof page>>();
      reads.set(sid, pending);
      return pending.promise;
    },
    now: () => 0,
    onReady: () => {},
  });
  const owners = Array.from({ length: MAX_PAIRINGS + 2 }, () => ({}));
  try {
    const first = replies.request(owners[0] as object, request("one", "iterm2:A"));
    expect(
      replies.request(owners[0] as object, { ...request("one", "iterm2:B"), before: 99 }),
    ).toBe(first);
    await expect(replies.request(owners[0] as object, request("two"))).resolves.toEqual(
      failed("two", "busy"),
    );
    await expect(
      replies.request(owners[1] as object, request("same", "iterm2:A")),
    ).resolves.toEqual(failed("same", "busy"));
    expect(called).toEqual(["iterm2:A:5:2"]);
    const active = [first];
    for (let i = 1; i < MAX_PAIRINGS; i++) {
      active.push(replies.request(owners[i] as object, request(`r${i}`, `iterm2:${i}`)));
    }
    expect(called).toHaveLength(MAX_PAIRINGS);
    await expect(
      replies.request(owners[MAX_PAIRINGS] as object, request("overflow", "iterm2:overflow")),
    ).resolves.toEqual(failed("overflow", "busy"));
    replies.cancel(owners[0] as object);
    await expect(first).resolves.toEqual(failed("one", "cancelled"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        replies.request(owners[MAX_PAIRINGS] as object, request(`still${attempt}`, "iterm2:A")),
      ).resolves.toEqual(failed(`still${attempt}`, "busy"));
    }
    await expect(
      replies.request(owners[MAX_PAIRINGS] as object, request("pool", "iterm2:new")),
    ).resolves.toEqual(failed("pool", "busy"));
    reads.get("iterm2:A")?.resolve(page());
    await Promise.resolve();
    const replacement = replies.request(
      owners[MAX_PAIRINGS] as object,
      request("free", "iterm2:A"),
    );
    // The prior native permit was released only on settlement; a new request now invokes read.
    expect(called).toHaveLength(MAX_PAIRINGS + 1);
    expect(called.at(-1)).toBe("iterm2:A:5:2");
    replies.clear();
    await Promise.all([...active.slice(1), replacement]);
  } finally {
    replies.clear();
    for (const pending of reads.values()) pending.resolve(page());
    await Promise.resolve();
  }
});

it("keeps requested cursor fields and a copied last-200 legacy page", async () => {
  const source = Array.from({ length: 205 }, (_, i) => ({ r: [{ t: `line ${i}` }] }));
  const read = vi.fn(async () => ({ lines: source, oldestAvailable: 37 }));
  const owner = {};
  const replies = new LegacyHistoryRequests({ read, now: () => 0, onReady: () => {} });
  const pending = replies.request(owner, { ...request(), before: 300, count: 200 });
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  if (source[5]?.r[0]) source[5].r[0].t = "mutated";
  let sent: InnerMessageOf<"history"> | undefined;
  expect(
    replies.sendOne(owner, (message) => {
      sent = message;
      return true;
    }),
  ).toBe(true);
  await expect(pending).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });
  expect(read).toHaveBeenCalledWith("iterm2:S", 300, 200);
  expect(sent).toEqual({
    type: "history",
    sessionId: "iterm2:S",
    before: 300,
    lines: Array.from({ length: 200 }, (_, i) => ({ r: [{ t: `line ${i + 5}` }] })),
    oldestAvailable: 37,
  });
  expect(InnerMessageSchema.safeParse(sent).success).toBe(true);
  expect(replies.hasReady(owner)).toBe(false);
});

it("rejects malformed input before admission and classifies native failures", async () => {
  const read = vi.fn(async () => page());
  const replies = new LegacyHistoryRequests({ read, now: () => 0, onReady: () => {} });
  expect(() => replies.request({}, { ...request(), count: 201 } as never)).toThrow(TypeError);
  expect(() => replies.request({}, { type: "ack", reqId: "x", ok: true } as never)).toThrow(
    TypeError,
  );
  expect(() =>
    replies.request({}, {
      type: "history.get",
      get reqId() {
        throw new Error("private terminal text");
      },
      sessionId: "iterm2:S",
      before: 5,
      count: 2,
    } as never),
  ).toThrow(new TypeError("Invalid legacy history request"));
  expect(read).not.toHaveBeenCalled();
  const malformed = new LegacyHistoryRequests({
    read: async () => ({ lines: [{ r: [{ t: 3 }] }] }) as never,
    now: () => 0,
    onReady: () => {},
  });
  await expect(malformed.request({}, request("bad"))).resolves.toEqual(
    failed("bad", "history-unavailable"),
  );
  const gone = new LegacyHistoryRequests({
    read: () => {
      throw new SessionGone("iterm2:S");
    },
    now: () => 0,
    onReady: () => {},
  });
  await expect(gone.request({}, request("gone"))).resolves.toEqual(failed("gone", "session-gone"));
  const goneAsync = new LegacyHistoryRequests({
    read: async () => {
      throw new SessionGone("iterm2:S");
    },
    now: () => 0,
    onReady: () => {},
  });
  await expect(goneAsync.request({}, request("gone-async"))).resolves.toEqual(
    failed("gone-async", "session-gone"),
  );
  const rejected = new LegacyHistoryRequests({
    read: async () => {
      throw new Error("secret terminal text");
    },
    now: () => 0,
    onReady: () => {},
  });
  await expect(rejected.request({}, request("rejected"))).resolves.toEqual(
    failed("rejected", "history-unavailable"),
  );
});

it("enforces the exact measured legacy reply ceiling without cropping text", async () => {
  const lines = Array.from({ length: 200 }, () => ({ r: [{ t: "é".repeat(2600) }] }));
  const reply = () => ({
    type: "history" as const,
    sessionId: "iterm2:S",
    before: 5,
    lines,
    oldestAvailable: 0,
  });
  let deficit = FRAME_LIMITS.e2eFromAgent - encodeCbor(reply()).byteLength;
  expect(deficit).toBeGreaterThan(0);
  for (const line of lines) {
    if (deficit < 2) break;
    const add = Math.min(4096 - line.r[0]!.t.length, Math.floor(deficit / 2));
    line.r[0]!.t += "é".repeat(add);
    deficit -= add * 2;
  }
  if (deficit === 1) lines[0]!.r[0]!.t += "x";
  expect(encodeCbor(reply()).byteLength).toBe(FRAME_LIMITS.e2eFromAgent);
  const exact = new LegacyHistoryRequests({
    read: async () => ({ lines, oldestAvailable: 0 }),
    now: () => 0,
    onReady: () => {},
  });
  const owner = {};
  const accepted = exact.request(owner, request());
  await vi.waitFor(() => expect(exact.hasReady(owner)).toBe(true));
  let admitted: InnerMessageOf<"history"> | undefined;
  expect(
    exact.sendOne(owner, (message) => {
      admitted = message;
      return true;
    }),
  ).toBe(true);
  await expect(accepted).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });
  expect(encodeCbor(admitted).byteLength).toBe(FRAME_LIMITS.e2eFromAgent);

  lines[199]!.r[0]!.t += "x";
  expect(encodeCbor(reply()).byteLength).toBe(FRAME_LIMITS.e2eFromAgent + 1);
  const above = new LegacyHistoryRequests({
    read: async () => ({ lines, oldestAvailable: 0 }),
    now: () => 0,
    onReady: () => {},
  });
  await expect(above.request({}, request("above"))).resolves.toEqual(
    failed("above", "history-too-large"),
  );
  const multibyte = new LegacyHistoryRequests({
    read: async () => ({
      lines: Array.from({ length: 200 }, () => ({ r: [{ t: "🚀".repeat(2048) }] })),
      oldestAvailable: 0,
    }),
    now: () => 0,
    onReady: () => {},
  });
  await expect(multibyte.request({}, request("multibyte"))).resolves.toEqual(
    failed("multibyte", "history-too-large"),
  );
  const invalidRun = new LegacyHistoryRequests({
    read: async () => page("x".repeat(4097)),
    now: () => 0,
    onReady: () => {},
  });
  await expect(invalidRun.request({}, request("invalid"))).resolves.toEqual(
    failed("invalid", "history-unavailable"),
  );
});

it("holds native permits past cancellation and timeout until settlement", async () => {
  let now = 0;
  const first = deferred<ReturnType<typeof page>>();
  const second = deferred<ReturnType<typeof page>>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const replies = new LegacyHistoryRequests({ read, now: () => now, onReady: () => {} });
  const original = {};
  const replacement = {};
  try {
    const pending = replies.request(original, request("first"));
    expect(replies.nextDeadline()).toBe(STREAM_LIMITS.totalMs);
    replies.cancel(original);
    await expect(pending).resolves.toEqual(failed("first", "cancelled"));
    await expect(replies.request(replacement, request("blocked"))).resolves.toEqual(
      failed("blocked", "busy"),
    );
    now = STREAM_LIMITS.totalMs + 100;
    replies.tick();
    await expect(replies.request(replacement, request("still-blocked"))).resolves.toEqual(
      failed("still-blocked", "busy"),
    );
    first.resolve(page());
    await Promise.resolve();
    const newer = replies.request(replacement, request("newer"));
    expect(read).toHaveBeenCalledTimes(2);
    now += STREAM_LIMITS.totalMs;
    replies.tick();
    await expect(newer).resolves.toEqual(failed("newer", "history-unavailable"));
    await expect(replies.request({}, request("again"))).resolves.toEqual(failed("again", "busy"));
    second.resolve(page());
    await Promise.resolve();
    expect(replies.nextDeadline()).toBeNull();
  } finally {
    replies.clear();
    first.resolve(page());
    second.resolve(page());
    await Promise.resolve();
  }
});

it("expires at read and ready boundaries with a monotonic clock", async () => {
  let now = 0;
  const readPending = deferred<ReturnType<typeof page>>();
  const replies = new LegacyHistoryRequests({
    read: () => readPending.promise,
    now: () => now,
    onReady: () => {},
  });
  const owner = {};
  try {
    const pending = replies.request(owner, request("read"));
    now = STREAM_LIMITS.totalMs - 1;
    expect(replies.hasReady(owner)).toBe(false);
    now = 0;
    expect(replies.nextDeadline()).toBe(STREAM_LIMITS.totalMs);
    now = STREAM_LIMITS.totalMs;
    readPending.resolve(page());
    await expect(pending).resolves.toEqual(failed("read", "history-unavailable"));
    expect(replies.nextDeadline()).toBeNull();
  } finally {
    readPending.resolve(page());
    replies.clear();
  }

  now = 0;
  const ready = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => now,
    onReady: () => {},
  });
  const readyOwner = {};
  const ack = ready.request(readyOwner, request("ready"));
  await vi.waitFor(() => expect(ready.hasReady(readyOwner)).toBe(true));
  expect(ready.nextDeadline()).toBe(STREAM_LIMITS.progressMs);
  now = STREAM_LIMITS.progressMs - 1;
  expect(ready.hasReady(readyOwner)).toBe(true);
  now = -10;
  expect(ready.hasReady(readyOwner)).toBe(true);
  now = STREAM_LIMITS.progressMs;
  expect(ready.sendOne(readyOwner, () => true)).toBe(false);
  await expect(ack).resolves.toEqual(failed("ready", "history-unavailable"));
  expect(ready.nextDeadline()).toBeNull();
});

it("uses the read deadline before classifying a SessionGone rejection", async () => {
  let now = 0;
  const native = deferred<ReturnType<typeof page>>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => native.promise)
    .mockImplementationOnce(async () => page());
  const replies = new LegacyHistoryRequests({ read, now: () => now, onReady: () => {} });
  const owner = {};
  try {
    const pending = replies.request(owner, request("old"));
    now = STREAM_LIMITS.totalMs;
    native.reject(new SessionGone("iterm2:S"));
    await expect(pending).resolves.toEqual(failed("old", "history-unavailable"));
    const next = replies.request(owner, request("new"));
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(read).toHaveBeenCalledTimes(2);
    expect(replies.sendOne(owner, () => true)).toBe(true);
    await expect(next).resolves.toEqual({ type: "ack", reqId: "new", ok: true });
  } finally {
    replies.clear();
    native.resolve(page());
  }
  now = 0;
  const synchronous = new LegacyHistoryRequests({
    read: () => {
      now = STREAM_LIMITS.totalMs;
      throw new SessionGone("iterm2:S");
    },
    now: () => now,
    onReady: () => {},
  });
  await expect(synchronous.request({}, request("sync"))).resolves.toEqual(
    failed("sync", "history-unavailable"),
  );
});

it("settles a synchronous provider throw of a revoked proxy without leaking its value", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const replies = new LegacyHistoryRequests({
    read: () => {
      throw revoked.proxy;
    },
    now: () => 0,
    onReady: () => {},
  });
  const owner = {};
  const pending = replies.request(owner, request("revoked"));
  await expect(pending).resolves.toEqual(failed("revoked", "history-unavailable"));
  expect(replies.hasReady(owner)).toBe(false);
  expect(replies.nextDeadline()).toBeNull();
});

it("settles an asynchronous hostile rejection without an unhandled rejection or stranded ACK", async () => {
  const native = deferred<ReturnType<typeof page>>();
  const replies = new LegacyHistoryRequests({
    read: () => native.promise,
    now: () => 0,
    onReady: () => {},
  });
  const owner = {};
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = replies.request(owner, request("hostile"));
    const completed: InnerMessageOf<"ack">[] = [];
    void pending.then((ack) => {
      completed.push(ack);
    });
    native.reject(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("private terminal content");
          },
        },
      ),
    );
    await vi.waitFor(() => expect(completed).toEqual([failed("hostile", "history-unavailable")]));
    await expect(pending).resolves.toEqual(failed("hostile", "history-unavailable"));
    expect(unhandled).toEqual([]);
    expect(replies.hasReady(owner)).toBe(false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    replies.clear();
    native.resolve(page());
  }
});

it("rechecks the deadline after error prototype inspection advances time", async () => {
  let now = 0;
  const replies = new LegacyHistoryRequests({
    read: async () => {
      throw new Proxy(
        {},
        {
          getPrototypeOf() {
            now = STREAM_LIMITS.totalMs;
            return SessionGone.prototype;
          },
        },
      );
    },
    now: () => now,
    onReady: () => {},
  });
  await expect(replies.request({}, request("boundary-trap"))).resolves.toEqual(
    failed("boundary-trap", "history-unavailable"),
  );
});

it("does not let error prototype inspection retire a replacement owner", async () => {
  const owner = {};
  let replacement: Promise<InnerMessageOf<"ack">> | undefined;
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: (sid) =>
      sid === "iterm2:old"
        ? Promise.reject(
            new Proxy(
              {},
              {
                getPrototypeOf() {
                  replies.cancel(owner);
                  replacement = replies.request(owner, request("new", "iterm2:new"));
                  return SessionGone.prototype;
                },
              },
            ),
          )
        : Promise.resolve(page("new")),
    now: () => 0,
    onReady: () => {},
  });
  const old = replies.request(owner, request("old", "iterm2:old"));
  await expect(old).resolves.toEqual(failed("old", "cancelled"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(
    replies.sendOne(owner, (message) => {
      expect(message.lines[0]?.r[0]?.t).toBe("new");
      return true;
    }),
  ).toBe(true);
  await expect(replacement).resolves.toEqual({ type: "ack", reqId: "new", ok: true });
});

it("rechecks elapsed read time after provider getters before installing a ready page", async () => {
  let now = 0;
  const native = deferred<ReturnType<typeof page>>();
  const onReady = vi.fn();
  const replies = new LegacyHistoryRequests({
    read: () => native.promise,
    now: () => now,
    onReady,
  });
  const owner = {};
  try {
    const pending = replies.request(owner, request("boundary"));
    now = STREAM_LIMITS.totalMs - 1;
    native.resolve({
      get lines() {
        now = STREAM_LIMITS.totalMs;
        return page().lines;
      },
      oldestAvailable: 0,
    });
    await Promise.resolve();
    expect(replies.hasReady(owner)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual(failed("boundary", "history-unavailable"));
    expect(replies.nextDeadline()).toBeNull();
  } finally {
    replies.clear();
    native.resolve(page());
  }
});

it("starts the ready deadline at the validated handoff time after provider work", async () => {
  let now = 0;
  const native = deferred<ReturnType<typeof page>>();
  const replies = new LegacyHistoryRequests({
    read: () => native.promise,
    now: () => now,
    onReady: () => {},
  });
  const owner = {};
  try {
    const pending = replies.request(owner, request("handoff"));
    now = 1000;
    native.resolve({
      get lines() {
        now = 1250;
        return page().lines;
      },
      oldestAvailable: 0,
    });
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(replies.nextDeadline()).toBe(1250 + STREAM_LIMITS.progressMs);
    expect(replies.sendOne(owner, () => true)).toBe(true);
    await expect(pending).resolves.toEqual({ type: "ack", reqId: "handoff", ok: true });
  } finally {
    replies.clear();
    native.resolve(page());
  }
});

it("does not install or notify a retired page when a provider getter replaces its owner", async () => {
  const oldNative = deferred<ReturnType<typeof page>>();
  const newNative = deferred<ReturnType<typeof page>>();
  const notifications: object[] = [];
  const owner = {};
  let replacement: Promise<InnerMessageOf<"ack">> | undefined;
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: (sid) => (sid === "iterm2:old" ? oldNative.promise : newNative.promise),
    now: () => 0,
    onReady: (readyOwner) => {
      notifications.push(readyOwner);
    },
  });
  try {
    const old = replies.request(owner, request("old", "iterm2:old"));
    oldNative.resolve({
      get lines() {
        replies.cancel(owner);
        replacement = replies.request(owner, request("replacement", "iterm2:new"));
        return page("obsolete").lines;
      },
      oldestAvailable: 0,
    });
    await expect(old).resolves.toEqual(failed("old", "cancelled"));
    expect(notifications).toEqual([]);
    expect(replies.hasReady(owner)).toBe(false);
    newNative.resolve(page("current"));
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(notifications).toEqual([owner]);
    expect(
      replies.sendOne(owner, (message) => {
        expect(message.lines[0]?.r[0]?.t).toBe("current");
        return true;
      }),
    ).toBe(true);
    await expect(replacement).resolves.toEqual({ type: "ack", reqId: "replacement", ok: true });
  } finally {
    replies.clear();
    oldNative.resolve(page());
    newNative.resolve(page());
  }
});

it("copies callbacks and rejects nonfinite clocks before changing ownership", async () => {
  expect(
    () =>
      new LegacyHistoryRequests({
        read: async () => page(),
        now: () => Number.NaN,
        onReady: () => {},
      }),
  ).toThrow(RangeError);
  let now = 0;
  const read = vi.fn(async () => page());
  const onReady = vi.fn();
  const options = { read, now: () => now, onReady };
  const replies = new LegacyHistoryRequests(options);
  options.read = vi.fn(async () => page("wrong"));
  options.onReady = vi.fn();
  const owner = {};
  const pending = replies.request(owner, request());
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledOnce();
  now = Number.POSITIVE_INFINITY;
  expect(() => replies.hasReady(owner)).toThrow(RangeError);
  expect(() => replies.sendOne(owner, () => true)).toThrow(RangeError);
  expect(() => replies.tick()).toThrow(RangeError);
  now = 0;
  expect(replies.hasReady(owner)).toBe(true);
  replies.cancel(owner);
  await expect(pending).resolves.toEqual(failed("r1", "cancelled"));
});

it("installs ownership before a synchronous provider can reenter", async () => {
  const owner = {};
  const native = deferred<ReturnType<typeof page>>();
  let same: Promise<InnerMessageOf<"ack">> | undefined;
  let different: Promise<InnerMessageOf<"ack">> | undefined;
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: () => {
      same = replies.request(owner, { ...request(), before: 99 });
      different = replies.request(owner, request("different"));
      return native.promise;
    },
    now: () => 0,
    onReady: () => {},
  });
  const first = replies.request(owner, request());
  expect(same).toBe(first);
  await expect(different).resolves.toEqual(failed("different", "busy"));
  try {
    native.resolve(page());
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(replies.sendOne(owner, () => true)).toBe(true);
    await expect(first).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });
  } finally {
    replies.clear();
    native.resolve(page());
  }
});

it("fences onReady cancellation, replacement, and later rejection by slot identity", async () => {
  const owner = {};
  const secondNative = deferred<ReturnType<typeof page>>();
  const notification = deferred<void>();
  let count = 0;
  let replacement: Promise<InnerMessageOf<"ack">> | undefined;
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: () => (++count === 1 ? Promise.resolve(page("old")) : secondNative.promise),
    now: () => 0,
    onReady: () => {
      if (count === 1) {
        replies.cancel(owner);
        replacement = replies.request(owner, request("new", "iterm2:New"));
        return notification.promise;
      }
    },
  });
  try {
    const old = replies.request(owner, request("old"));
    await expect(old).resolves.toEqual(failed("old", "cancelled"));
    expect(count).toBe(2);
    notification.reject(new Error("late notification failure with terminal text"));
    await Promise.resolve();
    secondNative.resolve(page("new"));
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(
      replies.sendOne(owner, (message) => {
        expect(message.lines[0]?.r[0]?.t).toBe("new");
        return true;
      }),
    ).toBe(true);
    await expect(replacement).resolves.toEqual({ type: "ack", reqId: "new", ok: true });
  } finally {
    replies.clear();
    secondNative.resolve(page());
    notification.resolve();
  }
});

it("permits onReady to admit its own page without resolving ACK inside the send callback", async () => {
  const owner = {};
  let admitted: InnerMessageOf<"history"> | undefined;
  const completed: InnerMessageOf<"ack">[] = [];
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: async () => page("ready"),
    now: () => 0,
    onReady: (readyOwner) => {
      expect(readyOwner).toBe(owner);
      expect(
        replies.sendOne(owner, (message) => {
          admitted = message;
          expect(completed).toEqual([]);
          return true;
        }),
      ).toBe(true);
    },
  });
  const pending = replies.request(owner, request());
  void pending.then((ack) => completed.push(ack));
  await expect(pending).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });
  expect(completed).toEqual([{ type: "ack", reqId: "r1", ok: true }]);
  expect(admitted?.lines[0]?.r[0]?.t).toBe("ready");
  expect(replies.hasReady(owner)).toBe(false);
});

it("contains synchronous and asynchronous notification failures without leaking pages", async () => {
  const throwing = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => 0,
    onReady: () => {
      throw new Error("private payload");
    },
  });
  await expect(throwing.request({}, request("throw"))).resolves.toEqual(
    failed("throw", "history-unavailable"),
  );
  const owner = {};
  const notified = deferred<void>();
  const asyncFailure = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => 0,
    onReady: () => notified.promise,
  });
  const pending = asyncFailure.request(owner, request("async"));
  await vi.waitFor(() => expect(asyncFailure.hasReady(owner)).toBe(true));
  notified.reject(new Error("private payload"));
  await expect(pending).resolves.toEqual(failed("async", "history-unavailable"));
  expect(asyncFailure.hasReady(owner)).toBe(false);
  const hostile = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => 0,
    onReady: () =>
      ({
        // biome-ignore lint/suspicious/noThenProperty: hostile thenable behavior is the test case.
        get then() {
          throw new Error("private payload");
        },
      }) as never,
  });
  await expect(hostile.request({}, request("hostile"))).resolves.toEqual(
    failed("hostile", "history-unavailable"),
  );
});

it("fences transport reentrancy and treats uncertain callbacks as failed admission", async () => {
  const owner = {};
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => 0,
    onReady: () => {},
  });
  const old = replies.request(owner, request("old"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  let recursive = true;
  expect(
    replies.sendOne(owner, () => {
      recursive = replies.sendOne(owner, () => true);
      replies.cancel(owner);
      return true;
    }),
  ).toBe(true);
  expect(recursive).toBe(false);
  await expect(old).resolves.toEqual(failed("old", "cancelled"));

  const second = replies.request(owner, request("second"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(
    replies.sendOne(owner, () => {
      replies.cancel(owner);
      void replies.request(owner, request("replacement", "iterm2:other"));
      return false;
    }),
  ).toBe(false);
  await expect(second).resolves.toEqual(failed("second", "cancelled"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(replies.sendOne(owner, () => true)).toBe(true);

  const uncertain = replies.request(owner, request("uncertain"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(() =>
    replies.sendOne(owner, () => Promise.reject(new Error("private page")) as never),
  ).toThrow("Legacy history send failed");
  await expect(uncertain).resolves.toEqual(failed("uncertain", "history-unavailable"));
  const thrown = replies.request(owner, request("thrown"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(() =>
    replies.sendOne(owner, () => {
      throw new Error("private page");
    }),
  ).toThrow("Legacy history send failed");
  await expect(thrown).resolves.toEqual(failed("thrown", "history-unavailable"));
  const hostile = replies.request(owner, request("hostile"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(() =>
    replies.sendOne(
      owner,
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: hostile thenable behavior is the test case.
          get then() {
            throw new Error("private page");
          },
        }) as never,
    ),
  ).toThrow("Legacy history send failed");
  await expect(hostile).resolves.toEqual(failed("hostile", "history-unavailable"));
});

it("does not let an old throwing transport callback retire its replacement", async () => {
  const owner = {};
  let replies: LegacyHistoryRequests;
  replies = new LegacyHistoryRequests({
    read: async (_sid) => page(_sid),
    now: () => 0,
    onReady: () => {},
  });
  const old = replies.request(owner, request("old"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  let newer: Promise<InnerMessageOf<"ack">> | undefined;
  expect(() =>
    replies.sendOne(owner, () => {
      replies.cancel(owner);
      newer = replies.request(owner, request("new", "iterm2:replacement"));
      throw new Error("private page");
    }),
  ).toThrow("Legacy history send failed");
  await expect(old).resolves.toEqual(failed("old", "cancelled"));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(
    replies.sendOne(owner, (message) => {
      expect(message.lines[0]?.r[0]?.t).toBe("iterm2:replacement");
      return true;
    }),
  ).toBe(true);
  await expect(newer).resolves.toEqual({ type: "ack", reqId: "new", ok: true });
});

it("clears all slots while retaining native permits and ignores late rejection", async () => {
  const pendingReads = new Map<string, ReturnType<typeof deferred<ReturnType<typeof page>>>>();
  const replies = new LegacyHistoryRequests({
    read: (sid) => {
      const pending = deferred<ReturnType<typeof page>>();
      pendingReads.set(sid, pending);
      return pending.promise;
    },
    now: () => 0,
    onReady: () => {},
  });
  const first = replies.request({}, request("one", "iterm2:one"));
  const second = replies.request({}, request("two", "iterm2:two"));
  try {
    replies.clear();
    await expect(first).resolves.toEqual(failed("one", "cancelled"));
    await expect(second).resolves.toEqual(failed("two", "cancelled"));
    expect(replies.nextDeadline()).toBeNull();
    await expect(replies.request({}, request("blocked", "iterm2:one"))).resolves.toEqual(
      failed("blocked", "busy"),
    );
    const owner = {};
    const third = replies.request(owner, request("three", "iterm2:three"));
    pendingReads.get("iterm2:one")?.reject(new Error("late private page"));
    await Promise.resolve();
    expect(replies.hasReady(owner)).toBe(false);
    pendingReads.get("iterm2:three")?.resolve(page("fresh"));
    await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
    expect(
      replies.sendOne(owner, (message) => {
        expect(message.lines[0]?.r[0]?.t).toBe("fresh");
        return true;
      }),
    ).toBe(true);
    await expect(third).resolves.toEqual({ type: "ack", reqId: "three", ok: true });
    const recovered = replies.request({}, request("recovered", "iterm2:one"));
    pendingReads.get("iterm2:one")?.resolve(page());
    replies.clear();
    await expect(recovered).resolves.toEqual(failed("recovered", "cancelled"));
  } finally {
    replies.clear();
    for (const pending of pendingReads.values()) pending.resolve(page());
    await Promise.resolve();
  }
});

it("refunds refused wire budget, charges admitted or uncertain attempts, and preserves healthy producers", async () => {
  let now = 0;
  const owner = {};
  const replies = new LegacyHistoryRequests({
    read: async () => page(),
    now: () => now,
    onReady: () => {},
  });
  const ack = replies.request(owner, request());
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  const scheduler = new WireScheduler({ now: () => now, maxFramesPerSecond: 40 });
  let allow = false;
  let healthy = 0;
  scheduler.register("legacy", () => replies.sendOne(owner, () => allow));
  scheduler.register("healthy", () => {
    healthy++;
    return true;
  });
  now = 25;
  expect(scheduler.pump()).toBe(1);
  expect(healthy).toBe(1);
  expect(replies.hasReady(owner)).toBe(true);
  allow = true;
  now = 50;
  expect(scheduler.pump()).toBe(1);
  await expect(ack).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });

  const owner2 = {};
  const uncertain = replies.request(owner2, request("uncertain", "iterm2:other"));
  await vi.waitFor(() => expect(replies.hasReady(owner2)).toBe(true));
  const errors: unknown[] = [];
  const second = new WireScheduler({
    now: () => now,
    maxFramesPerSecond: 40,
    onError: (error) => {
      errors.push(error);
    },
  });
  let other = 0;
  second.register("uncertain", () =>
    replies.sendOne(owner2, () => Promise.reject(new Error("private")) as never),
  );
  second.register("other", () => {
    other++;
    return true;
  });
  now = 75;
  expect(second.pump()).toBe(0);
  expect(other).toBe(0);
  expect(errors).toEqual([new Error("Legacy history send failed")]);
  await expect(uncertain).resolves.toEqual(failed("uncertain", "history-unavailable"));
  now = 100;
  expect(second.pump()).toBe(1);
  expect(other).toBe(1);
});

it("ACKs only after a ready legacy history page is admitted", async () => {
  const owner = {};
  const replies = new LegacyHistoryRequests({
    read: async () => ({ lines: [{ r: [{ t: "hello" }] }], oldestAvailable: 0 }),
    now: () => 0,
    onReady: () => {},
  });
  const completed: unknown[] = [];
  const pending = replies.request(owner, request());
  void pending.then((ack) => completed.push(ack));
  await vi.waitFor(() => expect(replies.hasReady(owner)).toBe(true));
  expect(replies.sendOne(owner, () => false)).toBe(false);
  await Promise.resolve();
  expect(completed).toEqual([]);
  expect(replies.sendOne(owner, () => true)).toBe(true);
  await expect(pending).resolves.toEqual({ type: "ack", reqId: "r1", ok: true });
});
