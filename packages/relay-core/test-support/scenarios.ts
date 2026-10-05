import {
  authMessage,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  sha256,
  sign,
} from "@shellbell/protocol";
import { box, type Conn, type ScenarioClient, TestDevice } from "./client.js";

type Equal = (actual: unknown, expected: unknown) => void;
interface Scenario {
  name: string;
  run(api: ScenarioClient, equal: Equal): Promise<void>;
}

/** Every pending close is bounded so a broken rejection fails rather than hanging. */
export async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function paired(api: ScenarioClient) {
  const host = new TestDevice("synthetic-host");
  const phone = new TestDevice("synthetic-phone");
  const { agent } = await api.agentOnline(host);
  await api.pair(agent, host, phone);
  const connected = await api.connect(host.fp);
  const auth = await api.authenticate(connected, phone, "phone");
  if (auth.type !== "auth-ok") throw new Error(`phone authentication failed: ${auth.type}`);
  await agent.nextCtrl(); // phone-connected
  return { host, phone, agent, connected };
}

function frame(from: string, to: string): Envelope {
  return {
    v: 1,
    t: "e2e",
    from,
    to,
    seq: 17,
    body: {
      n: new Uint8Array(24).fill(19),
      c: new Uint8Array([0, 255, 97, 116, 100, 99, 116, 114, 108]),
    },
  };
}

async function closed(conn: Conn, code: number, equal: Equal) {
  equal((await bounded(conn.closed, `close ${code}`)).code, code);
}

/** Runtime-free scenarios; the runner supplies its connector and assertion function. */
export const relayScenarios: readonly Scenario[] = [
  {
    name: "forwards valid noncanonical encoded frames byte-for-byte in both directions",
    async run(api, equal) {
      const { host, phone, agent, connected } = await paired(api);
      for (const [sender, recipient, from, to] of [
        [agent, connected, host.fp, phone.fp],
        [connected, agent, phone.fp, host.fp],
      ] as const) {
        const canonical = encodeEnvelope(frame(from, to));
        // A map length encoded with an extra byte is valid CBOR but noncanonical.
        const raw = new Uint8Array(canonical.length + 1);
        raw[0] = 0xb8;
        raw[1] = canonical[0]! & 31;
        raw.set(canonical.subarray(1), 2);
        equal(decodeEnvelope(raw), decodeEnvelope(canonical));
        sender.sendRaw(raw);
        equal(await recipient.nextRaw(), raw);
      }
    },
  },
  {
    name: "authenticates a paired synthetic phone",
    async run(api, equal) {
      const { host, phone, agent } = await paired(api);
      const replacement = await api.connect(host.fp);
      equal((await api.authenticate(replacement, phone, "phone")).type, "auth-ok");
      agent.close();
    },
  },
  {
    name: "rejects an agent claiming another computer fingerprint",
    async run(api, equal) {
      const conn = await api.connect(new TestDevice("synthetic-host").fp);
      equal(await api.authenticate(conn, new TestDevice("synthetic-other"), "agent"), {
        type: "auth-fail",
        reason: "fp-mismatch",
      });
      await closed(conn, 4001, equal);
    },
  },
  {
    name: "rejects a valid signature bound to the wrong role",
    async run(api, equal) {
      const host = new TestDevice("synthetic-host");
      const conn = await api.connect(host.fp);
      const ch = await conn.nextCtrl();
      if (ch.type !== "challenge") throw new Error("expected challenge");
      conn.sendCtrl(host.fp, {
        type: "auth",
        role: "agent",
        fp: host.fp,
        ed25519Pub: host.id.ed25519.pub,
        sig: sign(host.id.ed25519.priv, authMessage(ch.connId, "phone", host.fp, ch.nonce)),
        name: host.name,
        appVersion: "test",
      });
      equal(await conn.nextCtrl(), { type: "auth-fail", reason: "bad-sig" });
      await closed(conn, 4001, equal);
    },
  },
  {
    name: "rejects an unknown auth role at the wire boundary",
    async run(api, equal) {
      const host = new TestDevice("synthetic-host");
      const conn = await api.connect(host.fp);
      const ch = await conn.nextCtrl();
      if (ch.type !== "challenge") throw new Error("expected challenge");
      conn.sendCtrl(host.fp, {
        type: "auth",
        role: "unknown-role",
        fp: host.fp,
        ed25519Pub: host.id.ed25519.pub,
        sig: sign(host.id.ed25519.priv, authMessage(ch.connId, "unknown-role", host.fp, ch.nonce)),
        name: host.name,
        appVersion: "test",
      });
      await closed(conn, 4400, equal);
    },
  },
  ...["closed", "expired", "wrong"].map(
    (gateCase): Scenario => ({
      name: `rejects a ${gateCase} pairing gate`,
      async run(api, equal) {
        const { host, phone, agent, connected } = await paired(api);
        const gate = new Uint8Array(16).fill(7);
        agent.sendCtrl(host.fp, {
          type: "pairing-open",
          gateHash: sha256(gate),
          expiresAt: gateCase === "expired" ? Date.now() - 1 : Date.now() + 300_000,
        });
        if (gateCase === "closed") agent.sendCtrl(host.fp, { type: "pairing-close" });
        // Same-socket ordering: receipt proves preceding controls were processed.
        agent.sendEnvelope(frame(host.fp, phone.fp));
        equal((await connected.next()).seq, 17);
        const conn = await api.connect(host.fp);
        equal(
          await api.authenticate(conn, new TestDevice("synthetic-phone"), "pairing", {
            gate: gateCase === "wrong" ? new Uint8Array(16).fill(8) : gate,
          }),
          { type: "auth-fail", reason: "no-window" },
        );
        await closed(conn, 4001, equal);
      },
    }),
  ),
  {
    name: "allows only one request on a pairing socket",
    async run(api, equal) {
      const host = new TestDevice("synthetic-host");
      const phone = new TestDevice("synthetic-phone");
      const { agent } = await api.agentOnline(host);
      const gate = new Uint8Array(16).fill(7);
      agent.sendCtrl(host.fp, {
        type: "pairing-open",
        gateHash: sha256(gate),
        expiresAt: Date.now() + 300_000,
      });
      const conn = await api.connect(host.fp);
      equal((await api.authenticate(conn, phone, "pairing", { gate })).type, "auth-ok");
      conn.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
      equal(await agent.nextCtrl(), { type: "pairing-request", phoneFp: phone.fp, box: box() });
      conn.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
      await closed(conn, 4403, equal);
    },
  },
  {
    name: "preserves exact ciphertext bytes in both routing directions",
    async run(api, equal) {
      const { host, phone, agent, connected } = await paired(api);
      connected.sendEnvelope(frame(phone.fp, host.fp));
      const received = await agent.next();
      equal(received, {
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: host.fp,
        seq: 17,
        body: {
          n: new Uint8Array(24).fill(19),
          c: new Uint8Array([0, 255, 97, 116, 100, 99, 116, 114, 108]),
        },
      });
      agent.sendEnvelope(frame(host.fp, phone.fp));
      equal(await connected.next(), {
        v: 1,
        t: "e2e",
        from: host.fp,
        to: phone.fp,
        seq: 17,
        body: {
          n: new Uint8Array(24).fill(19),
          c: new Uint8Array([0, 255, 97, 116, 100, 99, 116, 114, 108]),
        },
      });
    },
  },
  {
    name: "rejects a spoofed sender fingerprint",
    async run(api, equal) {
      const { host, connected } = await paired(api);
      connected.sendEnvelope(frame("aaaaaaaaaaaaaaaaaaaaaaaaaa", host.fp));
      await closed(connected, 4403, equal);
    },
  },
  {
    name: "routes to the replacement phone socket after superseding the old socket",
    async run(api, equal) {
      const { host, phone, agent, connected } = await paired(api);
      const replacement = await api.connect(host.fp);
      equal((await api.authenticate(replacement, phone, "phone")).type, "auth-ok");
      await closed(connected, 4005, equal);
      const events = [await agent.nextCtrl(), await agent.nextCtrl()];
      equal(events.map((event) => event.type).sort(), ["phone-connected", "phone-disconnected"]);
      agent.sendEnvelope(frame(host.fp, phone.fp));
      equal((await replacement.next()).seq, 17);
    },
  },
  {
    name: "revokes an online phone and rejects its subsequent authentication",
    async run(api, equal) {
      const { host, phone, agent, connected } = await paired(api);
      agent.sendCtrl(host.fp, { type: "unpair", phoneFp: phone.fp });
      await closed(connected, 4004, equal);
      const again = await api.connect(host.fp);
      equal(await api.authenticate(again, phone, "phone"), {
        type: "auth-fail",
        reason: "not-paired",
      });
      await closed(again, 4001, equal);
    },
  },
  {
    name: "rejects agent-only control sent by an authenticated phone",
    async run(api, equal) {
      const { phone, connected } = await paired(api);
      connected.sendCtrl(phone.fp, { type: "pairing-close" });
      await closed(connected, 4403, equal);
    },
  },
  {
    name: "rejects an unauthenticated frame above 4 KiB",
    async run(api, equal) {
      const conn = await api.connect(new TestDevice("synthetic-host").fp);
      await conn.nextCtrl();
      conn.sendRaw(new Uint8Array(4097));
      await closed(conn, 4413, equal);
    },
  },
  {
    name: "accepts phone push registration and lease before routing a subsequent frame",
    async run(api, equal) {
      const { host, phone, agent, connected } = await paired(api);
      connected.sendCtrl(phone.fp, {
        type: "push-token",
        token: "ExponentPushToken[synthetic]",
        platform: "ios",
        enabled: false,
      });
      connected.sendCtrl(phone.fp, { type: "lease", ttlMs: 30_000 });
      connected.sendEnvelope(frame(phone.fp, host.fp));
      equal((await agent.next()).seq, 17);
    },
  },
  {
    name: "rejects phone push registration from the agent role",
    async run(api, equal) {
      const host = new TestDevice("synthetic-host");
      const { agent } = await api.agentOnline(host);
      agent.sendCtrl(host.fp, {
        type: "push-token",
        token: "ExponentPushToken[synthetic]",
        platform: "ios",
        enabled: false,
      });
      await closed(agent, 4403, equal);
    },
  },
  {
    name: "rejects malformed binary before authentication",
    async run(api, equal) {
      const conn = await api.connect(new TestDevice("synthetic-host").fp);
      await conn.nextCtrl();
      conn.sendRaw(new Uint8Array([255, 0, 1]));
      await closed(conn, 4400, equal);
    },
  },
];
