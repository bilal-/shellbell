import { EventEmitter } from "node:events";
import { FRAME_LIMITS, toBase64Url } from "@shellbell/protocol";
import { InboundQueue, QueueBudget } from "@shellbell/relay-core";
import { expect, it, vi } from "vitest";
import { bindNodeConnection } from "../src/connection.js";
import { createNodeTransport, type NodeSocket } from "../src/transport.js";

class TestSocket extends EventEmitter implements NodeSocket {
  readonly readyState = 1;
  readonly bufferedAmount = 0;
  readonly writes: (Uint8Array | string)[] = [];
  readonly closes: number[] = [];
  send(bytes: Uint8Array | string, done: (error?: Error) => void) {
    this.writes.push(bytes);
    done();
  }
  close(code: number) {
    this.closes.push(code);
  }
}

function connection(inbound: QueueBudget, message: () => Promise<void> = async () => {}) {
  const socket = new TestSocket();
  const transport = createNodeTransport(new QueueBudget(), 1024);
  const tasks: Promise<void>[] = [];
  bindNodeConnection(socket, {
    transport,
    inbound: new InboundQueue(inbound, 256),
    isStopping: () => false,
    isClosed: () => false,
    track(action) {
      const task = Promise.resolve().then(action);
      tasks.push(task);
      return task;
    },
    // The binder owns credits, not protocol transitions. Hold only the message
    // boundary; real QueueBudget/transport exercise reservation and close effects.
    core: {
      async open(connId) {
        transport.save({
          version: 1,
          connId,
          nonce: toBase64Url(new Uint8Array(32)),
          since: 1,
          state: "unauth",
          fp: null,
          name: null,
          leaseUntil: 0,
        });
      },
      message,
      close(id) {
        transport.close(id, 1000, "closed");
        return Promise.resolve();
      },
    },
  });
  return { socket, transport, tasks };
}

it("rejects oversized fragmented input before allocating a combined buffer", async () => {
  const h = connection(new QueueBudget());
  await h.tasks[0];
  const concatenate = vi.spyOn(Buffer, "concat");
  try {
    h.socket.emit("message", [Buffer.alloc(FRAME_LIMITS.unauth), Buffer.alloc(1)], true);
    expect(concatenate).not.toHaveBeenCalled();
    expect(h.socket.closes).toContain(4413);
    await Promise.all(h.tasks);
  } finally {
    concatenate.mockRestore();
  }
});

it("refunds admission and retires the connection if combining fragments fails", async () => {
  const budget = new QueueBudget(512, 512);
  const h = connection(budget);
  await h.tasks[0];
  const concatenate = vi.spyOn(Buffer, "concat").mockImplementation(() => {
    throw new Error("allocation failure");
  });
  try {
    expect(() => h.socket.emit("message", [Buffer.from([1])], true)).not.toThrow();
    expect(h.socket.closes).toContain(1011);
    expect(budget.reserve("other", 512)).toBe(true);
    await Promise.all(h.tasks);
  } finally {
    concatenate.mockRestore();
  }
});

it.each([false, true])(
  "holds inbound credit through close until settlement (running=%s)",
  async (running) => {
    const budget = new QueueBudget(512, 512);
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = connection(budget, () => {
      enter();
      return held;
    });
    await h.tasks[0];
    h.socket.emit("message", Buffer.from([1, 2]), true);
    if (running) await entered;
    // Two bytes plus the handler credit leave only 254 global bytes available.
    expect(budget.reserve("other", 255)).toBe(false);
    h.socket.emit("close");
    expect(h.transport.sessions()).toEqual([]);
    expect(budget.reserve("other", 255)).toBe(false);
    // Late events cannot reserve another handler against a removed session.
    h.socket.emit("message", Buffer.from([3, 4]), true);
    release();
    await Promise.all(h.tasks);
    expect(budget.reserve("other", 512)).toBe(true);
  },
);

it("refunds heartbeat bytes and handler credit immediately for subsequent pings", async () => {
  const budget = new QueueBudget(260, 260);
  const h = connection(budget);
  await h.tasks[0];
  for (let i = 0; i < 300; i++) h.socket.emit("message", Buffer.from("ping"), false);
  expect(h.socket.writes).toEqual(Array(300).fill("pong"));
  expect(h.socket.closes).toEqual([]);
  expect(budget.reserve("other", 260)).toBe(true);
});
