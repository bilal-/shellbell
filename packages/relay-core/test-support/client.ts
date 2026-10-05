import {
  authMessage,
  type CtrlMessage,
  type Envelope,
  fingerprint,
  generateIdentity,
  type Identity,
  type Role,
  sha256,
  sign,
} from "@shellbell/protocol";

export class TestDevice {
  readonly id: Identity;
  readonly fp: string;
  constructor(
    readonly name: string,
    identity: Identity = generateIdentity(),
  ) {
    this.id = identity;
    this.fp = fingerprint(this.id.ed25519.pub);
  }
}

/** The connector owns transport setup; scenarios use only this portable contract. */
export interface Conn {
  /** Consumes the same receive queue as next()/nextCtrl(), preserving exact bytes. */
  nextRaw(timeoutMs?: number): Promise<Uint8Array>;
  next(timeoutMs?: number): Promise<Envelope>;
  nextCtrl(timeoutMs?: number): Promise<CtrlMessage>;
  sendCtrl(from: string, body: unknown): void;
  sendEnvelope(e: Envelope): void;
  sendRaw(bytes: Uint8Array): void;
  closed: Promise<{ code: number }>;
  close(): void;
}

export const box = () => ({ n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) });

export function createScenarioClient<C extends Conn>(connect: (computerFp: string) => Promise<C>) {
  async function authenticate(
    conn: Conn,
    dev: TestDevice,
    role: Role,
    opts: { gate?: Uint8Array } = {},
  ): Promise<CtrlMessage> {
    const ch = await conn.nextCtrl();
    if (ch.type !== "challenge") throw new Error(`expected challenge, got ${ch.type}`);
    const sig = sign(dev.id.ed25519.priv, authMessage(ch.connId, role, dev.fp, ch.nonce));
    conn.sendCtrl(dev.fp, {
      type: "auth",
      role,
      fp: dev.fp,
      ed25519Pub: dev.id.ed25519.pub,
      sig,
      name: dev.name,
      appVersion: "test",
      gate: opts.gate,
    });
    return conn.nextCtrl();
  }

  async function agentOnline(mac: TestDevice): Promise<{
    agent: C;
    unpaired: CtrlMessage;
    phones: CtrlMessage;
  }> {
    const agent = await connect(mac.fp);
    const ok = await authenticate(agent, mac, "agent");
    if (ok.type !== "auth-ok") throw new Error(`agent auth failed: ${JSON.stringify(ok)}`);
    const unpaired = await agent.nextCtrl();
    const phones = await agent.nextCtrl();
    return { agent, unpaired, phones };
  }

  /** Relay-side pairing dance with a gate; leaves the pairing row in place. */
  async function pair(agent: Conn, mac: TestDevice, phone: TestDevice): Promise<void> {
    const gate = new Uint8Array(16).fill(7);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    const pairing = await connect(mac.fp);
    try {
      const ok = await authenticate(pairing, phone, "pairing", { gate });
      if (ok.type !== "auth-ok") throw new Error(`pairing auth failed: ${JSON.stringify(ok)}`);
      pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
      const fwd = await agent.nextCtrl();
      if (fwd.type !== "pairing-request")
        throw new Error(`expected pairing-request, got ${fwd.type}`);
      agent.sendCtrl(mac.fp, {
        type: "pairing-add",
        phoneFp: phone.fp,
        ed25519Pub: phone.id.ed25519.pub,
        name: phone.name,
      });
      agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: box() });
      agent.sendCtrl(mac.fp, { type: "pairing-close" });
      const resp = await pairing.nextCtrl();
      if (resp.type !== "pairing-response")
        throw new Error(`expected pairing-response, got ${resp.type}`);
    } finally {
      pairing.close();
    }
  }

  return { connect, authenticate, agentOnline, pair };
}

export type ScenarioClient = ReturnType<typeof createScenarioClient>;
