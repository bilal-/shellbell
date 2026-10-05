import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  pairingAd,
  parseQr,
  seal,
} from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { chooseConfirm, resolveRelayOverride } from "../src/cli.js";
import { loadConfig, loadPairings, paths, saveConfig } from "../src/config.js";
import { configRevision } from "../src/config-values.js";
import { ControlServer } from "../src/control.js";
import { ControlLineDecoder } from "../src/control-framing.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FrozenHelloSchema, FrozenStatusSchema } from "./fixtures/control-v2-20260921/status.js";

type Frame = {
  id?: number;
  ok?: boolean;
  data?: Record<string, unknown>;
  event?: string;
  flowId?: string;
  challengeId?: string;
  phoneFp?: string;
  error?: { code: string };
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(relayOverride?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-ctl-v2-"));
  const p = paths(dir);
  const identity = generateIdentity();
  const resolved = resolveRelayOverride(
    { ...loadConfig(p), computerName: "Test Mac" },
    relayOverride,
  );
  if ("error" in resolved) throw new Error(resolved.error);
  const config = resolved.cfg;
  const log = createLogger({ stdout: false });
  const registry = new BackendRegistry(log);
  registry.add(new FakeBackend());
  let server!: ControlServer;
  const routing: { server: ControlServer | null } = { server: null };
  const agent = new Agent({
    paths: p,
    config,
    identity,
    fp: fingerprint(identity.ed25519.pub),
    registry,
    log,
    appVersion: "0.0.1-test",
    confirm: chooseConfirm(routing, false, async () => {
      throw new Error("pairing consent must have an owning control client");
    }),
    onPairingClosed: () => server.notifyClosed(),
  });
  server = new ControlServer(join(dir, "agent.sock"), agent, log);
  routing.server = server;
  await server.start();
  const sockets: Socket[] = [];
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await server.stop();
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = { ...agent.localStatus.process };
  async function connect(hello = true) {
    const socket = createConnection(join(dir, "agent.sock"));
    sockets.push(socket);
    const frames: Frame[] = [];
    const decoder = new ControlLineDecoder({
      onLine: (line) => frames.push(JSON.parse(line)),
      onError: () => {
        throw new Error("invalid server framing");
      },
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("end", () => decoder.finish());
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let id = 0;
    const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
    async function call(cmd: string, args?: unknown, expectRuntime = runtime) {
      const requestId = ++id;
      send({
        v: 2,
        id: requestId,
        cmd,
        ...(["hello", "status", "status.config", "devices"].includes(cmd)
          ? {}
          : { expect: expectRuntime }),
        ...(args === undefined ? {} : { args }),
      });
      await vi.waitFor(() => expect(frames.some((frame) => frame.id === requestId)).toBe(true));
      return frames.find((frame) => frame.id === requestId)!;
    }
    if (hello) expect(await call("hello")).toMatchObject({ ok: true, data: { version: 2 } });
    return { socket, frames, send, call };
  }
  return { agent, server, runtime, p, connect, config };
}

function phoneRequest(qrText: string, phone = generateIdentity()) {
  const qr = parseQr(qrText);
  const phoneFp = fingerprint(phone.ed25519.pub);
  const box = seal(
    derivePskKey(fromBase64Url(qr.p), qr.c),
    encodeCbor({
      ed25519Pub: phone.ed25519.pub,
      x25519Pub: phone.x25519.pub,
      name: "Phone",
      platform: "ios",
    }),
    pairingAd("request", qr.c, phoneFp),
  );
  return { type: "pairing-request" as const, phoneFp, box };
}

async function challenge(
  f: Awaited<ReturnType<typeof fixture>>,
  client: Awaited<ReturnType<typeof f.connect>>,
) {
  const opened = await client.call("pairing.open");
  expect(opened.ok).toBe(true);
  const decision = f.server.nativePairingConfirm("b".repeat(26), "Phone");
  await vi.waitFor(() =>
    expect(client.frames.some((frame) => frame.event === "pairing.request")).toBe(true),
  );
  const event = client.frames.filter((frame) => frame.event === "pairing.request").at(-1)!;
  return {
    decision,
    args: {
      flowId: event.flowId!,
      challengeId: event.challengeId!,
      phoneFp: event.phoneFp!,
      accept: true,
    },
  };
}

describe("negotiated control server", () => {
  it("retains historical strict status, hello capabilities and runtime ownership shapes", async () => {
    const f = await fixture();
    const c = await f.connect();
    expect(FrozenHelloSchema.safeParse(c.frames[0]!.data).success).toBe(true);
    expect(c.frames[0]!.data!.runtime).toEqual(f.runtime);
    const status = (await c.call("status")).data;
    expect(FrozenStatusSchema.safeParse(status).success).toBe(true);
    expect(
      FrozenStatusSchema.safeParse({ ...status, configurationRevision: "a".repeat(64) }).success,
    ).toBe(false);
    expect(
      FrozenHelloSchema.safeParse({
        ...c.frames[0]!.data,
        capabilities: ["status", "devices", "pairing", "revoke", "settings"],
      }).success,
    ).toBe(false);
  });
  it("reports the effective startup relay override and keeps it after saved settings change", async () => {
    const f = await fixture("wss://effective.invalid");
    const c = await f.connect();
    const applied = configRevision({
      ...loadConfig(f.p),
      computerName: "Test Mac",
      relayUrl: "wss://effective.invalid",
    });
    expect(applied).not.toBe(configRevision(loadConfig(f.p)));
    expect(await c.call("status.config")).toMatchObject({ ok: true, data: { revision: applied } });
    saveConfig(f.p, { ...loadConfig(f.p), relayUrl: "wss://later.invalid" });
    f.config.relayUrl = "wss://caller.invalid";
    const opened = await c.call("pairing.open");
    expect(parseQr(String(opened.data!.qrText)).r).toBe("wss://effective.invalid");
    expect(f.agent.configurationRevision).toBe(applied);
  });
  it("reports applied configuration independently of disk and the caller's mutable startup object", async () => {
    const f = await fixture();
    const c = await f.connect();
    expect(f.agent.configurationRevision).toMatch(/^[0-9a-f]{64}$/);
    const revision = f.agent.configurationRevision;
    expect(await c.call("status.config")).toMatchObject({ ok: true, data: { revision } });
    f.config.computerName = "Caller changed";
    saveConfig(f.p, { ...f.config, relayUrl: "wss://different.invalid" });
    expect(await c.call("status.config")).toMatchObject({ ok: true, data: { revision } });
    const opened = await c.call("pairing.open");
    expect(parseQr(String(opened.data!.qrText)).n).toBe("Test Mac");
  });
  it("keeps one pairing owner across native and legacy callers", async () => {
    const f = await fixture();
    const native = await f.connect();
    const legacy = await f.connect(false);
    expect(f.agent.pairingOpen).toBe(false);
    f.agent.openPairing();
    expect(f.agent.pairingOpen).toBe(true);
    expect(await native.call("pairing.open")).toMatchObject({ error: { code: "pairing-busy" } });
    f.agent.closePairing();
    const opened = await native.call("pairing.open");
    expect(opened.ok).toBe(true);
    expect(await native.call("pairing.open")).toMatchObject({ error: { code: "pairing-busy" } });
    for (const cmd of ["pair-open", "pair-close", "confirm"]) legacy.send({ cmd });
    await vi.waitFor(() => expect(legacy.frames).toHaveLength(3));
    for (const frame of legacy.frames) expect(frame).toMatchObject({ ok: false });
    expect(f.server.hasNativePairOwner).toBe(true);
    expect(f.agent.pairingOpen).toBe(true);
  });

  it.each(["submitted", "current"] as const)(
    "rejects a %s runtime mismatch before mutation",
    async (changed) => {
      const f = await fixture();
      const c = await f.connect();
      if (changed === "current")
        vi.spyOn(f.agent, "localStatus", "get").mockReturnValue({
          ...f.agent.localStatus,
          process: { ...f.runtime, pid: f.runtime.pid + 1 },
        });
      expect(
        await c.call(
          "pairing.open",
          undefined,
          changed === "submitted" ? { ...f.runtime, pid: f.runtime.pid + 1 } : f.runtime,
        ),
      ).toMatchObject({ error: { code: "runtime-mismatch" } });
      expect(f.agent.pairing.isOpen).toBe(false);
    },
  );

  it("binds consent to socket, flow, fingerprint and current challenge", async () => {
    const f = await fixture();
    const owner = await f.connect();
    const stranger = await f.connect();
    const { decision, args } = await challenge(f, owner);
    expect(await stranger.call("pairing.confirm", args)).toMatchObject({
      error: { code: "stale-flow" },
    });
    expect(await owner.call("pairing.confirm", { ...args, flowId: "x".repeat(22) })).toMatchObject({
      error: { code: "stale-flow" },
    });
    expect(await owner.call("pairing.confirm", { ...args, phoneFp: "c".repeat(26) })).toMatchObject(
      { error: { code: "stale-challenge" } },
    );
    expect(
      await owner.call("pairing.confirm", { ...args, challengeId: "x".repeat(22) }),
    ).toMatchObject({ error: { code: "stale-challenge" } });
    expect(await owner.call("pairing.confirm", { ...args, accept: false })).toMatchObject({
      ok: true,
    });
    await expect(decision).resolves.toBe(false);
    const next = f.server.nativePairingConfirm(args.phoneFp, "Phone");
    await vi.waitFor(() =>
      expect(owner.frames.filter((frame) => frame.event === "pairing.request")).toHaveLength(2),
    );
    expect(await owner.call("pairing.confirm", args)).toMatchObject({
      error: { code: "stale-challenge" },
    });
    const replacement = owner.frames.filter((frame) => frame.event === "pairing.request").at(-1)!;
    expect(
      await owner.call("pairing.confirm", { ...args, challengeId: replacement.challengeId }),
    ).toMatchObject({ ok: true });
    await expect(next).resolves.toBe(true);
  });

  it("preserves the hello snapshot when the current runtime object changes in place", async () => {
    const f = await fixture();
    const c = await f.connect();
    f.agent.localStatus.process.pid += 1;
    expect(
      await c.call("pairing.open", undefined, { ...f.agent.localStatus.process }),
    ).toMatchObject({ error: { code: "runtime-mismatch" } });
    expect(f.agent.pairing.isOpen).toBe(false);
  });

  it("an old close cannot close a replacement flow", async () => {
    const f = await fixture();
    const c = await f.connect();
    const old = await challenge(f, c);
    expect(await c.call("pairing.close", { flowId: old.args.flowId })).toMatchObject({ ok: true });
    await expect(old.decision).resolves.toBe(false);
    const replacement = await c.call("pairing.open");
    expect(replacement.data?.flowId).not.toBe(old.args.flowId);
    expect(await c.call("pairing.close", { flowId: old.args.flowId })).toMatchObject({
      error: { code: "stale-flow" },
    });
    expect(f.agent.pairing.isOpen).toBe(true);
    expect(f.server.hasNativePairOwner).toBe(true);
  });

  it("retains synchronous opening consent and sends open response before request event", async () => {
    const f = await fixture();
    const c = await f.connect();
    const open = f.agent.openPairing.bind(f.agent);
    let decision!: Promise<boolean>;
    vi.spyOn(f.agent, "openPairing").mockImplementation(() => {
      const result = open();
      decision = f.server.nativePairingConfirm("b".repeat(26), "Phone");
      return result;
    });
    const response = await c.call("pairing.open");
    await vi.waitFor(() => expect(c.frames).toHaveLength(3));
    expect(c.frames[1]).toBe(response);
    expect(c.frames[2]).toMatchObject({ event: "pairing.request", flowId: response.data?.flowId });
    const event = c.frames[2]!;
    await c.call("pairing.confirm", {
      flowId: event.flowId,
      challengeId: event.challengeId,
      phoneFp: event.phoneFp,
      accept: true,
    });
    await expect(decision).resolves.toBe(true);
  });

  it.each(["close", "throw", "invalid result", "oversized result"] as const)(
    "cleans up a synchronous opening %s",
    async (failure) => {
      const f = await fixture();
      const c = await f.connect();
      const open = f.agent.openPairing.bind(f.agent);
      let decision!: Promise<boolean>;
      vi.spyOn(f.agent, "openPairing").mockImplementation(() => {
        const result = open();
        decision = f.server.nativePairingConfirm("b".repeat(26), "Phone");
        if (failure === "close") f.agent.closePairing();
        if (failure === "throw") throw new Error("private path and QR must not escape");
        if (failure === "invalid result") return { ...result, qrText: "" };
        if (failure === "oversized result") return { ...result, qrText: "q".repeat(65_536) };
        return result;
      });
      expect(await c.call("pairing.open")).toEqual({
        v: 2,
        id: 2,
        ok: false,
        error: { code: failure === "oversized result" ? "response-too-large" : "operation-failed" },
      });
      await expect(decision).resolves.toBe(false);
      expect(f.server.hasNativePairOwner).toBe(false);
      expect(f.agent.pairing.isOpen).toBe(false);
      expect(c.frames.some((frame) => frame.event === "pairing.request")).toBe(false);
      expect(await c.call("status")).toMatchObject({ ok: true });
    },
  );

  it.each(["disconnect", "stop"] as const)("declines pending consent on owner %s", async (end) => {
    const f = await fixture();
    const c = await f.connect();
    const { decision } = await challenge(f, c);
    if (end === "disconnect") c.socket.destroy();
    else await f.server.stop();
    await expect(decision).resolves.toBe(false);
    expect(f.server.hasNativePairOwner).toBe(false);
    expect(f.agent.pairing.isOpen).toBe(false);
  });

  it("expires consent at the real window deadline before the periodic tick", async () => {
    const f = await fixture();
    const c = await f.connect();
    const opened = await c.call("pairing.open");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Number(opened.data?.expiresAt) - 10);
    const decision = f.server.nativePairingConfirm("b".repeat(26), "Phone");
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toBe(false);
    // No Agent.start()/tick runs in this fixture. The socket stays responsive afterward.
    vi.useRealTimers();
    expect(await c.call("status")).toMatchObject({ ok: true });
  });

  it("rejects an answer after deadline even before the timeout callback runs", async () => {
    const f = await fixture();
    const c = await f.connect();
    const { args, decision } = await challenge(f, c);
    const opened = c.frames.find((frame) => frame.id === 2)!;
    vi.spyOn(Date, "now").mockReturnValue(Number(opened.data?.expiresAt));
    expect(await c.call("pairing.confirm", args)).toMatchObject({ error: { code: "stale-flow" } });
    await expect(decision).resolves.toBe(false);
    expect(f.server.hasNativePairOwner).toBe(false);
  });

  it("accepted consent followed by window close cannot persist the phone", async () => {
    const f = await fixture();
    const c = await f.connect();
    const opened = await c.call("pairing.open");
    const request = f.agent.pairing.handleRequest(phoneRequest(String(opened.data?.qrText)));
    await vi.waitFor(() =>
      expect(c.frames.some((frame) => frame.event === "pairing.request")).toBe(true),
    );
    const event = c.frames.find((frame) => frame.event === "pairing.request")!;
    const ctrl = vi.spyOn(f.agent.relay, "sendCtrl");
    c.socket.write(
      `${JSON.stringify({ v: 2, id: 3, cmd: "pairing.confirm", expect: f.runtime, args: { flowId: event.flowId, challengeId: event.challengeId, phoneFp: event.phoneFp, accept: true } })}\n${JSON.stringify({ v: 2, id: 4, cmd: "pairing.close", expect: f.runtime, args: { flowId: event.flowId } })}\n`,
    );
    await request;
    await vi.waitFor(() => expect(c.frames.some((frame) => frame.id === 4)).toBe(true));
    expect(c.frames.find((frame) => frame.id === 3)).toMatchObject({ ok: true });
    expect(f.agent.pairingList).toEqual([]);
    expect(loadPairings(f.p)).toEqual([]);
    expect(ctrl.mock.calls.flatMap(([message]) => message.type)).toEqual(["pairing-close"]);
  });

  it("declines expired legacy consent without its late continuation affecting the native replacement", async () => {
    const f = await fixture();
    const legacy = await f.connect(false);
    legacy.send({ cmd: "pair-open" });
    await vi.waitFor(() => expect(legacy.frames).toHaveLength(1));
    const phone = generateIdentity();
    const phoneFp = fingerprint(phone.ed25519.pub);
    const legacyConfirm = f.server.pairingConfirm;
    let legacyDecision!: Promise<boolean>;
    let releaseLegacy!: () => void;
    const continuationGate = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    // Keep the real legacy decision/notification path, but delay delivery of its
    // result to PairingManager until the same phone owns a new native challenge.
    vi.spyOn(f.server, "pairingConfirm").mockImplementation((fp, name) => {
      legacyDecision = legacyConfirm(fp, name);
      return legacyDecision.then(async (accepted) => {
        await continuationGate;
        return accepted;
      });
    });
    const oldRequest = f.agent.pairing.handleRequest(
      phoneRequest(String(legacy.frames[0]?.data?.qrText), phone),
    );
    try {
      await vi.waitFor(() =>
        expect(legacy.frames.some((frame) => frame.event === "request")).toBe(true),
      );
      expect(legacy.frames[1]).toMatchObject({ event: "request", phoneFp });
      const outbound = vi.spyOn(f.agent.relay, "sendCtrl");
      vi.spyOn(Date, "now").mockReturnValue(Number(legacy.frames[0]?.data?.expiresAt));
      const native = await f.connect();
      const opened = await native.call("pairing.open");
      expect(opened.ok).toBe(true);
      await expect(legacyDecision).resolves.toBe(false);
      await vi.waitFor(() =>
        expect(legacy.frames.some((frame) => frame.event === "closed")).toBe(true),
      );
      expect(f.server.hasPairClients).toBe(false);

      const replacementRequest = f.agent.pairing.handleRequest(
        phoneRequest(String(opened.data?.qrText), phone),
      );
      await vi.waitFor(() =>
        expect(native.frames.some((frame) => frame.event === "pairing.request")).toBe(true),
      );
      const event = native.frames.find((frame) => frame.event === "pairing.request")!;
      expect(event).toMatchObject({ flowId: opened.data?.flowId, phoneFp });
      releaseLegacy();
      await oldRequest;
      expect(f.server.hasNativePairOwner).toBe(true);
      expect(f.agent.pairing.isOpen).toBe(true);
      expect(f.agent.pairingList).toEqual([]);
      expect(loadPairings(f.p)).toEqual([]);
      expect(outbound.mock.calls.map(([message]) => message.type)).toEqual([
        "pairing-close",
        "pairing-open",
      ]);

      expect(
        await native.call("pairing.confirm", {
          flowId: event.flowId,
          challengeId: event.challengeId,
          phoneFp,
          accept: true,
        }),
      ).toMatchObject({ ok: true });
      await replacementRequest;
      expect(f.agent.pairingList.map((pairing) => pairing.phoneFp)).toEqual([phoneFp]);
      expect(loadPairings(f.p).map((pairing) => pairing.phoneFp)).toEqual([phoneFp]);
      expect(outbound.mock.calls.map(([message]) => message.type)).toEqual([
        "pairing-close",
        "pairing-open",
        "pairing-add",
        "pairing-response",
        "pairing-close",
      ]);
    } finally {
      releaseLegacy();
    }
  });

  it("consumes invalid request IDs so reuse cannot execute a mutation", async () => {
    const f = await fixture();
    const c = await f.connect();
    c.send({ v: 2, id: 2, cmd: "status", unexpected: true });
    await vi.waitFor(() => expect(c.frames).toHaveLength(2));
    expect(c.frames[1]).toMatchObject({ error: { code: "bad-request" } });
    c.send({ v: 2, id: 2, cmd: "pairing.open", expect: f.runtime });
    await vi.waitFor(() => expect(c.socket.destroyed).toBe(true));
    expect(f.agent.pairing.isOpen).toBe(false);
    expect(c.frames).toHaveLength(2);
  });

  it.each([1, 2])(
    "does not respond again to consumed ID %s even with an unsupported version",
    async (id) => {
      const f = await fixture();
      const c = await f.connect();
      if (id === 2) {
        c.send({ v: 2, id, cmd: "status", unexpected: true });
        await vi.waitFor(() => expect(c.frames).toHaveLength(2));
      }
      c.send({ v: 3, id, cmd: "status" });
      await vi.waitFor(() => expect(c.socket.destroyed).toBe(true));
      expect(c.frames).toHaveLength(id);
    },
  );

  it("reports unsupported version for an unused ID before closing", async () => {
    const f = await fixture();
    const c = await f.connect();
    c.send({ v: 3, id: 2, cmd: "status" });
    await vi.waitFor(() => expect(c.socket.destroyed).toBe(true));
    expect(c.frames).toHaveLength(2);
    expect(c.frames[1]).toEqual({ v: 2, id: 2, ok: false, error: { code: "unsupported-version" } });
  });

  it.each(["legacy to v2", "v2 to legacy", "malformed JSON"] as const)(
    "terminates %s after protocol selection",
    async (mode) => {
      const f = await fixture();
      const c = await f.connect(mode !== "legacy to v2");
      if (mode === "legacy to v2") {
        c.send({ cmd: "status" });
        await vi.waitFor(() => expect(c.frames).toHaveLength(1));
        c.send({ v: 2, id: 2, cmd: "pair-open" });
      } else if (mode === "v2 to legacy") c.send({ cmd: "pair-open" });
      else c.socket.write("{not-json\n");
      await vi.waitFor(() => expect(c.socket.destroyed).toBe(true));
      expect(f.agent.pairing.isOpen).toBe(false);
      expect(c.frames).toHaveLength(1);
    },
  );

  it("a status-only native client does not override --yes consent", async () => {
    const f = await fixture();
    const c = await f.connect();
    await c.call("status");
    const confirm = chooseConfirm({ server: f.server }, true, async () => {
      throw new Error("TTY must not run");
    });
    await expect(confirm("b".repeat(26), "Phone")).resolves.toBe(true);
    expect(c.frames).toHaveLength(2);
    expect(f.server.hasNativePairOwner).toBe(false);
  });
});
