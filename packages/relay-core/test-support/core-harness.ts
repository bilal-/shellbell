import {
  authMessage,
  type CtrlMessage,
  decodeEnvelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  type Role,
  sign,
} from "@shellbell/protocol";
import {
  createRelayCore,
  type NotificationService,
  type RelayTransport,
  type SessionRecord,
} from "../src/index.js";
import { MemoryIdentity } from "./memory-identity.js";

export function device(name: string) {
  const id = generateIdentity();
  return { id, fp: fingerprint(id.ed25519.pub), name };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function harness() {
  const agent = device("Mac");
  const identity = new MemoryIdentity();
  const sessions = new Map<string, SessionRecord>();
  const frames = new Map<string, Uint8Array[]>();
  const closes: { id: string; code: number; reason: string }[] = [];
  const reports: string[] = [];
  const deadlines: (number | null)[] = [];
  const notifications: NotificationService = {
    async register() {},
    async enqueue() {},
    async cancelPhone() {},
    async pump() {},
    async nextDeadline() {
      return null;
    },
  };
  let now = 100_000;
  let nonce = 0;
  const options = {
    computerFp: agent.fp,
    identity,
    notifications,
    runtime: {
      now: () => now,
      randomId: () => "random-id",
      randomBytes: (n: number) => new Uint8Array(n).fill(++nonce),
      report: (event: string) => {
        reports.push(event);
      },
    },
    scheduler: {
      async replace(deadline: number | null) {
        deadlines.push(deadline);
      },
    },
    transport: {
      session: (id: string) => {
        const record = sessions.get(id);
        return record && { ...record };
      },
      sessions: () => [...sessions.values()].map((record) => ({ ...record })),
      save: (session: SessionRecord) => {
        sessions.set(session.connId, structuredClone(session));
      },
      send: (id: string, bytes: Uint8Array): ReturnType<RelayTransport["send"]> => {
        if (!sessions.has(id)) return "closed";
        const out = frames.get(id) ?? [];
        out.push(new Uint8Array(bytes));
        frames.set(id, out);
        return "sent";
      },
      close: (id: string, code: number, reason: string) => {
        closes.push({ id, code, reason });
        sessions.delete(id);
      },
    },
  };
  const core = createRelayCore(options);
  const ctrl = (id: string, from: string, body: unknown) =>
    core.message(id, encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body }));
  const bodies = (id: string) =>
    (frames.get(id) ?? []).map((raw) => decodeEnvelope(raw).body as CtrlMessage);
  function auth(id: string, dev: ReturnType<typeof device>, role: Role, gate?: Uint8Array) {
    const ch = bodies(id)
      .filter((b) => b.type === "challenge")
      .at(-1);
    if (ch?.type !== "challenge") throw new Error("missing challenge");
    return ctrl(id, dev.fp, {
      type: "auth",
      role,
      fp: dev.fp,
      name: dev.name,
      ed25519Pub: dev.id.ed25519.pub,
      sig: sign(dev.id.ed25519.priv, authMessage(ch.connId, role, dev.fp, ch.nonce)),
      appVersion: "test",
      ...(gate ? { gate } : {}),
    });
  }
  async function connect(id: string, dev = agent, role: Role = "agent") {
    await core.open(id);
    await auth(id, dev, role);
  }
  async function pair(dev = device("Phone")) {
    await ctrl("agent", agent.fp, {
      type: "pairing-add",
      phoneFp: dev.fp,
      ed25519Pub: dev.id.ed25519.pub,
      name: dev.name,
    });
    return dev;
  }
  return {
    core,
    options,
    identity,
    notifications,
    sessions,
    frames,
    closes,
    reports,
    deadlines,
    agent,
    ctrl,
    auth,
    connect,
    pair,
    bodies,
    setNow: (value: number) => {
      now = value;
    },
  };
}
