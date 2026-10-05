import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_LIMITS,
  ControlServer,
  controlPairSession,
  controlRequest,
} from "../src/control.js";
import { createLogger } from "../src/log.js";

function newSock(): string {
  return join(mkdtempSync(join(tmpdir(), "sb-ctl-")), "agent.sock");
}

function fakeAgent() {
  return {
    localStatus: {
      controlVersion: 1 as const,
      process: {
        pid: 4242,
        agentVersion: "0.0.1-test",
        computerFp: "a".repeat(26),
        stateDir: "/tmp/shellbell-test-state",
        serviceInstance: null,
      },
      backends: [
        { name: "iterm2" as const, connected: true },
        { name: "tmux" as const, connected: false },
        { name: "herdr" as const, connected: false },
      ],
      terminalReady: true,
    },
    relayOnline: true,
    pairingList: [{ phoneFp: "a".repeat(26), name: "iPhone", lastSeenAt: null }],
    sessionList: [{ id: "iterm2:x" }],
    connectedPhones: [],
    unpair: (t: string) => t === "iPhone",
    openPairing: () => ({ qrText: "{}", expiresAt: 1 }),
    closePairing: () => {},
  };
}

describe("control socket", () => {
  async function checkBoundedPeer(mode: "eof" | "oversize" | "timeout", timeoutMs: number) {
    const dir = mkdtempSync(join(tmpdir(), "sb-ctl-bounds-"));
    const sock = join(dir, "agent.sock");
    const peers = new Set<Socket>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    let request: Promise<unknown> | undefined;
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    let reply: (() => void) | undefined;
    const server = createServer((socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => peers.delete(socket));
      socket.once("data", () => {
        reply = () => {
          if (mode === "eof") socket.end();
          if (mode === "oversize") socket.write("x".repeat(1025));
        };
        requestReceived();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sock, () => {
          server.off("error", reject);
          resolve();
        });
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      request = controlRequest(sock, "status", undefined, {
        timeoutMs,
        maxResponseBytes: 1024,
      });
      const expected = mode === "eof" ? /closed/ : mode === "oversize" ? /large/ : /timed out/;
      // Observe rejection immediately, including in the intentional RED run.
      const rejection = request.then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          barrierTimer = realSetTimeout(
            () => reject(new Error("peer did not receive request")),
            4_000,
          );
        }),
        request.then(
          () => Promise.reject(new Error("request settled before the peer received it")),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      // The response-shape cases deliberately outlive the old 20 ms deadline.
      await vi.advanceTimersByTimeAsync(mode === "timeout" ? 21 : 75);
      const sendResponse = reply;
      reply = undefined;
      sendResponse?.();
      expect(((await rejection) as Error | null)?.message).toMatch(expected);
    } finally {
      if (barrierTimer) realClearTimeout(barrierTimer);
      reply?.();
      for (const peer of peers) peer.destroy();
      try {
        if (request) {
          await vi.advanceTimersByTimeAsync(timeoutMs + 1);
          await Promise.allSettled([request]);
        }
      } finally {
        vi.useRealTimers();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  it.each(["eof", "oversize"] as const)(
    "reports a %s response after a widened scheduling window",
    async (mode) => checkBoundedPeer(mode, 2_000),
  );

  it("times out a peer that sends no response", async () => checkBoundedPeer("timeout", 20));
  it("declines pending pairing confirmations when stopped", async () => {
    const server = new ControlServer(
      newSock(),
      fakeAgent() as never,
      createLogger({ stdout: false }),
    );
    await server.start();
    const decision = server.pairingConfirm("d".repeat(26), "Phone");
    await server.stop();
    expect(await decision).toBe(false);
  });
  it("refuses a live owner without a PID file and preserves it after failed claimant stop", async () => {
    const sock = newSock();
    const first = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    const second = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await first.start();
    try {
      await expect(second.start()).rejects.toThrow(/running|busy|in use/);
      expect(await controlRequest(sock, "status")).toMatchObject({
        controlVersion: 1,
        sessions: 1,
      });
      await second.stop();
      expect(await controlRequest(sock, "status")).toMatchObject({
        controlVersion: 1,
        sessions: 1,
      });
    } finally {
      // The old implementation incorrectly started second; close it before first in RED.
      if (existsSync(sock)) await second.stop();
      await first.stop();
    }
  });

  it("old-owner stop preserves a replacement listener and PID file", async () => {
    const sock = newSock();
    const pid = `${sock}.pid`;
    const first = new ControlServer(
      sock,
      fakeAgent() as never,
      createLogger({ stdout: false }),
      pid,
    );
    const replacement = new ControlServer(
      sock,
      fakeAgent() as never,
      createLogger({ stdout: false }),
      pid,
    );
    await first.start();
    unlinkSync(sock);
    if (existsSync(pid)) unlinkSync(pid);
    await replacement.start();
    // Legacy server did not publish its own PID.
    if (!existsSync(pid)) writeFileSync(pid, String(process.pid));
    try {
      await first.stop();
      expect(existsSync(pid)).toBe(true);
      expect(await controlRequest(sock, "status")).toMatchObject({ controlVersion: 1 });
    } finally {
      await replacement.stop();
    }
  });
  it("answers status/devices/unpair and rejects unknown commands", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const status = (await controlRequest(sock, "status")) as {
      controlVersion: number;
      process: { pid: number; agentVersion: string };
      backends: { name: string; connected: boolean }[];
      terminalReady: boolean;
      relayOnline: boolean;
      sessions: number;
    };
    expect(status.controlVersion).toBe(1);
    expect(status.process).toMatchObject({ pid: 4242, agentVersion: "0.0.1-test" });
    expect(status.backends).toEqual([
      { name: "iterm2", connected: true },
      { name: "tmux", connected: false },
      { name: "herdr", connected: false },
    ]);
    expect(status.terminalReady).toBe(true);
    expect(status.relayOnline).toBe(true);
    expect(status.sessions).toBe(1);
    expect(((await controlRequest(sock, "devices")) as { name: string }[])[0]?.name).toBe("iPhone");
    expect(await controlRequest(sock, "unpair", { target: "iPhone" })).toEqual({ removed: true });
    await expect(controlRequest(sock, "nope")).rejects.toThrow(/unknown command/);
    await server.stop();
  });

  it("creates the socket with mode 0600 (spec 8.2)", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    await server.stop();
  });

  it("serves two concurrent clients independently", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const [status, devices] = await Promise.all([
      controlRequest(sock, "status") as Promise<{ relayOnline: boolean }>,
      controlRequest(sock, "devices") as Promise<{ name: string }[]>,
    ]);
    expect(status.relayOnline).toBe(true);
    expect(devices[0]?.name).toBe("iPhone");
    await server.stop();
  });

  it("closes the seventeenth idle control connection without dispatching it", async () => {
    // Removing admission control lets idle clients consume all local socket resources indefinitely.
    const sock = newSock();
    let opened = 0;
    const agent = {
      ...fakeAgent(),
      openPairing: () => {
        opened += 1;
        return { qrText: "{}", expiresAt: 1 };
      },
    };
    const server = new ControlServer(sock, agent as never, createLogger({ stdout: false }));
    const clients: Socket[] = [];
    try {
      await server.start();
      for (let index = 0; index < CONTROL_LIMITS.connections; index++) {
        const client = createConnection(sock);
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          client.once("connect", resolve);
          client.once("error", reject);
        });
      }
      const replies = clients.map(
        (client) =>
          new Promise<unknown>((resolve) => {
            client.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString("utf8"))));
          }),
      );
      for (const client of clients) client.write(`${JSON.stringify({ cmd: "status" })}\n`);
      for (const reply of await Promise.all(replies)) expect(reply).toMatchObject({ ok: true });
      const overflow = createConnection(sock);
      clients.push(overflow);
      let closed = false;
      overflow.once("close", () => {
        closed = true;
      });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(opened).toBe(0);
      const released = new Promise<void>((resolve) => clients[0]?.once("close", () => resolve()));
      clients[0]?.destroy();
      await released;
      await expect(controlRequest(sock, "status")).resolves.toMatchObject({ controlVersion: 1 });
    } finally {
      for (const client of clients) client.destroy();
      await server.stop();
    }
  });

  it("stops coalesced pairing events when its owner closes the session", async () => {
    // Continuing after onOpen closes the session can surface a consent prompt from a closed view.
    const dir = mkdtempSync(join(tmpdir(), "sb-ctl-coalesced-"));
    const sock = join(dir, "agent.sock");
    const peer = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({ ok: true, data: { qrText: "{}", expiresAt: 1 } })}\n${JSON.stringify({ event: "request", phoneFp: "b".repeat(26), name: "Phone" })}\n`,
        );
      });
      socket.once("end", () => socket.end());
    });
    await new Promise<void>((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(sock, resolve);
    });
    let session!: ReturnType<typeof controlPairSession>;
    let requests = 0;
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => {
      opened = resolve;
    });
    try {
      session = controlPairSession(sock, {
        onOpen: () => {
          session.close();
          opened();
        },
        onRequest: async () => {
          requests += 1;
          return false;
        },
        onClose: () => {},
        onError: (error) => {
          throw error;
        },
      });
      await openedPromise;
      expect(requests).toBe(0);
    } finally {
      session?.close();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases an idle admission slot when the initial request timer expires", async () => {
    // Omitting the initial timer lets an idle peer permanently consume one of sixteen slots.
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    try {
      await server.start();
      vi.useFakeTimers();
      const idle = createConnection(sock);
      await new Promise<void>((resolve, reject) => {
        idle.once("connect", resolve);
        idle.once("error", reject);
      });
      const closed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
      await vi.advanceTimersByTimeAsync(CONTROL_LIMITS.initialRequestMs);
      await closed;
      await expect(controlRequest(sock, "status")).resolves.toMatchObject({ controlVersion: 1 });
    } finally {
      vi.useRealTimers();
      await server.stop();
    }
  });

  it("returns {ok:false} for malformed JSON and keeps the connection usable", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const socket = createConnection(sock);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const rl = createInterface({ input: socket });
    const nextLine = () => new Promise<string>((resolve) => rl.once("line", resolve));

    socket.write("not json at all\n");
    expect(JSON.parse(await nextLine())).toEqual({ ok: false, error: "bad json" });

    socket.write(`${JSON.stringify({ cmd: "status" })}\n`);
    const res = JSON.parse(await nextLine()) as { ok: boolean; data?: { relayOnline: boolean } };
    expect(res.ok).toBe(true);
    expect(res.data?.relayOnline).toBe(true);

    socket.end();
    await server.stop();
  });

  it("does not send `closed` to the client whose pair-open re-opened the window", async () => {
    const sock = newSock();
    // openPairing() on the real PairingManager closes a previous window first, which broadcasts
    // `closed` to every registered client. The client that is opening must not be registered yet.
    let server!: ControlServer;
    const agent = {
      ...fakeAgent(),
      openPairing: () => {
        server.notifyClosed();
        return { qrText: "{}", expiresAt: 1 };
      },
    };
    server = new ControlServer(sock, agent as never, createLogger({ stdout: false }));
    await server.start();

    let closedCount = 0;
    const opened = new Promise<string>((resolve) => {
      controlPairSession(sock, {
        onOpen: (qrText) => resolve(qrText),
        onRequest: () => Promise.resolve(false),
        onClose: () => {
          closedCount += 1;
        },
        onError: (e) => {
          throw e;
        },
      });
    });
    expect(await opened).toBe("{}");
    await new Promise((r) => setTimeout(r, 100));
    expect(closedCount).toBe(0);
    await server.stop();
  });

  it("streams pair-open requests, resolves pairingConfirm on confirm, and emits closed", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();

    let resolveOpen!: (v: { qrText: string; expiresAt: number }) => void;
    const opened = new Promise<{ qrText: string; expiresAt: number }>((r) => {
      resolveOpen = r;
    });
    let resolveRequest!: (v: { phoneFp: string; name: string }) => void;
    const requested = new Promise<{ phoneFp: string; name: string }>((r) => {
      resolveRequest = r;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    const decision: { resolve: ((accept: boolean) => void) | null } = { resolve: null };

    const session = controlPairSession(sock, {
      onOpen: (qrText, expiresAt) => resolveOpen({ qrText, expiresAt }),
      onRequest: (phoneFp, name) => {
        resolveRequest({ phoneFp, name });
        return new Promise<boolean>((resolve) => {
          decision.resolve = resolve;
        });
      },
      onClose: () => resolveClosed(),
      onError: (e) => {
        throw e;
      },
    });

    const openMsg = await opened;
    expect(openMsg.qrText).toBe("{}");

    const phoneFp = "b".repeat(26);
    const confirmResult = server.pairingConfirm(phoneFp, "Bilal's iPhone");
    const req = await requested;
    expect(req).toEqual({ phoneFp, name: "Bilal's iPhone" });
    decision.resolve?.(true);
    expect(await confirmResult).toBe(true);

    server.notifyClosed();
    await closed;

    session.close();
    await server.stop();
  });

  it("declines a second confirm request for the same fp instead of clobbering the first", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const fp = "c".repeat(26);
    const first = server.pairingConfirm(fp, "Phone1");
    const second = await server.pairingConfirm(fp, "Phone1-again");
    expect(second).toBe(false);
    await controlRequest(sock, "confirm", { phoneFp: fp, accept: true });
    expect(await first).toBe(true);
    await server.stop();
  });

  describe("agent.pid liveness (M1)", () => {
    it("refuses to start when agent.pid names a live process", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      writeFileSync(pid, String(process.pid));
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await expect(server.start()).rejects.toThrow(/already running/);
    });

    it("starts normally and replaces a stale pid file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      writeFileSync(pid, "999999999");
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await server.start();
      expect(readFileSync(pid, "utf8")).toBe(String(process.pid));
      await server.stop();
    });

    it("stop() removes both the socket and the pid file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await server.start();
      writeFileSync(pid, String(process.pid));
      expect(existsSync(sock)).toBe(true);
      await server.stop();
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(pid)).toBe(false);
    });
  });
});

describe("controlRequest", () => {
  it("rejects with a clear error when the server sends malformed JSON", async () => {
    const sock = newSock();
    // A minimal raw server that replies with garbage, standing in for a wedged/buggy peer.
    const { createServer } = await import("node:net");
    const raw = createServer((socket) => {
      socket.on("data", () => socket.write("not json\n"));
    });
    await new Promise<void>((resolve) => raw.listen(sock, resolve));
    await expect(controlRequest(sock, "status")).rejects.toThrow(/malformed/);
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });

  it("rejects when the socket closes during a partial response", async () => {
    // Resolving partial data after a close would turn an unknown request outcome into success.
    const sock = newSock();
    const raw = createServer((socket) => {
      socket.once("data", () => {
        socket.write('{"ok":true,"data":');
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject);
      raw.listen(sock, resolve);
    });
    try {
      await expect(controlRequest(sock, "status")).rejects.toThrow(/closed|malformed/);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });
});
