import {
  authMessage,
  type CtrlMessage,
  decodeEnvelope,
  encodeCbor,
  FRAME_LIMITS,
  sha256,
  sign,
} from "@shellbell/protocol";
import { TokenBucket } from "@shellbell/relay-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentOnline,
  authenticate,
  box,
  type Conn,
  connect,
  pairPhone,
  TestDevice,
} from "./helpers.js";

const sockets: Conn[] = [];
const OLD_CTRL_SIGNATURE = new Uint8Array([0x61, 0x74, 0x64, 0x63, 0x74, 0x72, 0x6c]);

async function open(computerFp: string): Promise<Conn> {
  const conn = await connect(computerFp);
  sockets.push(conn);
  return conn;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expectClosed(conn: Conn, code: number): Promise<void> {
  expect((await bounded(conn.closed, 1_000, `waiting for close ${code}`)).code).toBe(code);
}

function encodeStringPadded(
  targetBytes: number,
  build: (padding: string) => Uint8Array,
): Uint8Array {
  let paddingLength = Math.max(0, targetBytes - build("").byteLength);
  for (let attempt = 0; attempt < 10; attempt++) {
    const encoded = build("x".repeat(paddingLength));
    if (encoded.byteLength === targetBytes) return encoded;
    paddingLength += targetBytes - encoded.byteLength;
    if (paddingLength < 0) break;
  }
  throw new Error(`could not encode string-padded frame at ${targetBytes} bytes`);
}

function encodeBytesPadded(
  targetBytes: number,
  prefix: Uint8Array,
  build: (ciphertext: Uint8Array) => Uint8Array,
): Uint8Array {
  let ciphertextLength = Math.max(prefix.byteLength, targetBytes - build(prefix).byteLength);
  for (let attempt = 0; attempt < 10; attempt++) {
    const ciphertext = new Uint8Array(ciphertextLength);
    ciphertext.set(prefix);
    const encoded = build(ciphertext);
    if (encoded.byteLength === targetBytes) return encoded;
    ciphertextLength += targetBytes - encoded.byteLength;
    if (ciphertextLength < prefix.byteLength) break;
  }
  throw new Error(`could not encode byte-padded frame at ${targetBytes} bytes`);
}

function encodeOrderedMap(entries: ReadonlyArray<readonly [string, unknown]>): Uint8Array {
  if (entries.length > 23) throw new Error("test CBOR helper only supports small maps");
  const chunks: Uint8Array[] = [new Uint8Array([0xa0 + entries.length])];
  for (const [key, value] of entries) chunks.push(encodeCbor(key), encodeCbor(value));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const encoded = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoded;
}

function sizedCtrl(targetBytes: number, from: string, body: unknown): Uint8Array {
  return encodeStringPadded(targetBytes, (padding) =>
    encodeOrderedMap([
      ["padding", padding],
      ["v", 1],
      ["t", "ctrl"],
      ["from", from],
      ["seq", 0],
      ["body", body],
    ]),
  );
}

function sizedE2E(
  targetBytes: number,
  from: string,
  to: string,
  prefix = new Uint8Array(),
): Uint8Array {
  return encodeBytesPadded(targetBytes, prefix, (ciphertext) =>
    encodeOrderedMap([
      ["body", { c: ciphertext, n: new Uint8Array(24) }],
      ["v", 1],
      ["t", "e2e"],
      ["from", from],
      ["to", to],
      ["seq", 1],
    ]),
  );
}

function signatureOffset(bytes: Uint8Array, signature: Uint8Array): number {
  outer: for (let i = 0; i <= bytes.byteLength - signature.byteLength; i++) {
    for (let j = 0; j < signature.byteLength; j++) {
      if (bytes[i + j] !== signature[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function sendSizedAuth(
  conn: Conn,
  device: TestDevice,
  targetBytes: number,
): Promise<CtrlMessage> {
  const challenge = await conn.nextCtrl();
  if (challenge.type !== "challenge") throw new Error(`expected challenge, got ${challenge.type}`);
  const sig = sign(
    device.id.ed25519.priv,
    authMessage(challenge.connId, "agent", device.fp, challenge.nonce),
  );
  const bytes = sizedCtrl(targetBytes, device.fp, {
    type: "auth",
    role: "agent",
    fp: device.fp,
    ed25519Pub: device.id.ed25519.pub,
    sig,
    name: device.name,
    appVersion: "test",
  });
  expect(bytes.byteLength).toBe(targetBytes);
  conn.sendRaw(bytes);
  return conn.nextCtrl();
}

async function nextText(ws: WebSocket): Promise<string> {
  return bounded(
    new Promise<string>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        ws.removeEventListener("message", listener);
        resolve(event.data);
      };
      ws.addEventListener("message", listener);
    }),
    1_000,
    "waiting for heartbeat response",
  );
}

async function setupPaired(): Promise<{
  mac: TestDevice;
  phone: TestDevice;
  agent: Conn;
  phoneConn: Conn;
}> {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  sockets.push(agent);
  await pairPhone(mac, agent, phone);
  const phoneConn = await open(mac.fp);
  expect(await authenticate(phoneConn, phone, "phone")).toMatchObject({ type: "auth-ok" });
  await agent.nextCtrl();
  return { mac, phone, agent, phoneConn };
}

async function openPairing(
  mac: TestDevice,
  agent: Conn,
  phone: TestDevice,
  gate: Uint8Array,
): Promise<Conn> {
  agent.sendCtrl(mac.fp, {
    type: "pairing-open",
    gateHash: sha256(gate),
    expiresAt: Date.now() + 300_000,
  });
  const pairing = await open(mac.fp);
  expect(await authenticate(pairing, phone, "pairing", { gate })).toMatchObject({
    type: "auth-ok",
  });
  return pairing;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const conn of sockets) {
    try {
      conn.ws.close();
    } catch {
      // already closed
    }
  }
  await Promise.allSettled(
    sockets.map((conn) => bounded(conn.closed, 1_000, "cleaning up socket")),
  );
  sockets.length = 0;
});

describe("relay frame limits", () => {
  it("rejects oversized unauthenticated text", async () => {
    const conn = await open(new TestDevice("host").fp);
    await conn.nextCtrl();
    conn.ws.send("x".repeat(1024 * 1024));
    await expectClosed(conn, 4413);
  });

  it("rejects arbitrary short text and text bursts as malformed", async () => {
    const short = await open(new TestDevice("short").fp);
    await short.nextCtrl();
    short.ws.send("not-cbor");
    await expectClosed(short, 4400);

    const burst = await open(new TestDevice("burst").fp);
    await burst.nextCtrl();
    burst.ws.send("one");
    burst.ws.send("two");
    burst.ws.send("three");
    await expectClosed(burst, 4400);
  });

  it("measures bounded multibyte text in UTF-8 bytes", async () => {
    const exact = await open(new TestDevice("exact").fp);
    await exact.nextCtrl();
    exact.ws.send("é".repeat(FRAME_LIMITS.unauth / 2));
    await expectClosed(exact, 4400);

    const over = await open(new TestDevice("over").fp);
    await over.nextCtrl();
    over.ws.send(`${"é".repeat(FRAME_LIMITS.unauth / 2)}a`);
    await expectClosed(over, 4413);
  });

  it("keeps automatic heartbeat text outside the application gate", async () => {
    const mac = new TestDevice("MBP");
    const conn = await open(mac.fp);
    const pong = nextText(conn.ws);
    conn.ws.send("ping");
    expect(await pong).toBe("pong");
    expect(await authenticate(conn, mac, "agent")).toMatchObject({
      type: "auth-ok",
      role: "agent",
    });
  });

  it("charges application text to the connection rate limit before rejecting it", async () => {
    vi.spyOn(TokenBucket.prototype, "take").mockReturnValue(false);
    const conn = await open(new TestDevice("rate").fp);
    await conn.nextCtrl();
    conn.ws.send("application text");
    await expectClosed(conn, 4429);
  });

  it("accepts a valid unauthenticated frame at 4 KiB and rejects 4 KiB + 1", async () => {
    const acceptedDevice = new TestDevice("accepted");
    const accepted = await open(acceptedDevice.fp);
    expect(await sendSizedAuth(accepted, acceptedDevice, FRAME_LIMITS.unauth)).toMatchObject({
      type: "auth-ok",
      role: "agent",
    });

    const rejectedDevice = new TestDevice("rejected");
    const rejected = await open(rejectedDevice.fp);
    const response = sendSizedAuth(rejected, rejectedDevice, FRAME_LIMITS.unauth + 1);
    await expectClosed(rejected, 4413);
    await expect(response).rejects.toThrow("socket closed");
  });

  it("rejects malformed binary below the unauthenticated cap", async () => {
    const conn = await open(new TestDevice("malformed").fp);
    await conn.nextCtrl();
    conn.sendRaw(new Uint8Array([0xff, 0x00, 0x01]));
    await expectClosed(conn, 4400);
  });

  it("accepts late-type agent control at 16 KiB", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    sockets.push(agent);
    const gate = new Uint8Array(16).fill(1);
    const bytes = sizedCtrl(FRAME_LIMITS.ctrl, mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    expect(bytes.byteLength).toBe(FRAME_LIMITS.ctrl);
    expect(signatureOffset(bytes, OLD_CTRL_SIGNATURE)).toBeGreaterThan(64);
    agent.sendRaw(bytes);

    const pairing = await open(mac.fp);
    expect(await authenticate(pairing, new TestDevice("phone"), "pairing", { gate })).toMatchObject(
      {
        type: "auth-ok",
      },
    );
  });

  it("rejects late-type agent control at 16 KiB + 1 without opening pairing", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    sockets.push(agent);
    const gate = new Uint8Array(16).fill(2);
    const bytes = sizedCtrl(FRAME_LIMITS.ctrl + 1, mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    expect(bytes.byteLength).toBe(FRAME_LIMITS.ctrl + 1);
    expect(signatureOffset(bytes, OLD_CTRL_SIGNATURE)).toBeGreaterThan(64);
    agent.sendRaw(bytes);
    await expectClosed(agent, 4413);

    const { agent: replacement } = await agentOnline(mac);
    sockets.push(replacement);
    const pairing = await open(mac.fp);
    expect(await authenticate(pairing, new TestDevice("phone"), "pairing", { gate })).toEqual({
      type: "auth-fail",
      reason: "no-window",
    });
  });

  it("enforces the decoded control cap for authenticated phones", async () => {
    const { mac, phone, agent, phoneConn } = await setupPaired();
    const accepted = sizedCtrl(FRAME_LIMITS.ctrl, phone.fp, { type: "lease", ttlMs: 30_000 });
    expect(accepted.byteLength).toBe(FRAME_LIMITS.ctrl);
    expect(signatureOffset(accepted, OLD_CTRL_SIGNATURE)).toBeGreaterThan(64);
    phoneConn.sendRaw(accepted);
    phoneConn.sendEnvelope({
      v: 1,
      t: "e2e",
      from: phone.fp,
      to: mac.fp,
      seq: 1,
      body: { n: new Uint8Array(24), c: new Uint8Array([7]) },
    });
    expect(((await agent.next()).body as { c: Uint8Array }).c).toEqual(new Uint8Array([7]));

    const rejected = sizedCtrl(FRAME_LIMITS.ctrl + 1, phone.fp, {
      type: "lease",
      ttlMs: 30_000,
    });
    expect(rejected.byteLength).toBe(FRAME_LIMITS.ctrl + 1);
    phoneConn.sendRaw(rejected);
    await expectClosed(phoneConn, 4413);
  });

  it("enforces 16 KiB control frames for pairing sockets without forwarding oversized requests", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    sockets.push(agent);
    const gate = new Uint8Array(16).fill(3);

    const acceptedPhone = new TestDevice("accepted");
    const acceptedPairing = await openPairing(mac, agent, acceptedPhone, gate);
    const accepted = sizedCtrl(FRAME_LIMITS.ctrl, acceptedPhone.fp, {
      type: "pairing-request",
      phoneFp: acceptedPhone.fp,
      box: box(),
    });
    expect(accepted.byteLength).toBe(FRAME_LIMITS.ctrl);
    acceptedPairing.sendRaw(accepted);
    expect(await agent.nextCtrl()).toMatchObject({
      type: "pairing-request",
      phoneFp: acceptedPhone.fp,
    });

    const rejectedPhone = new TestDevice("rejected");
    const rejectedPairing = await openPairing(mac, agent, rejectedPhone, gate);
    const rejected = sizedCtrl(FRAME_LIMITS.ctrl + 1, rejectedPhone.fp, {
      type: "pairing-request",
      phoneFp: rejectedPhone.fp,
      box: box(),
    });
    expect(rejected.byteLength).toBe(FRAME_LIMITS.ctrl + 1);
    rejectedPairing.sendRaw(rejected);
    await expectClosed(rejectedPairing, 4413);
    await expect(agent.nextCtrl(250)).rejects.toThrow("timeout waiting for frame");
  });

  it("routes phone E2E at 64 KiB and rejects 64 KiB + 1", async () => {
    const { mac, phone, agent, phoneConn } = await setupPaired();
    const accepted = sizedE2E(FRAME_LIMITS.e2eFromPhone, phone.fp, mac.fp);
    expect(accepted.byteLength).toBe(FRAME_LIMITS.e2eFromPhone);
    phoneConn.sendRaw(accepted);
    expect((await agent.next()).t).toBe("e2e");

    const rejected = sizedE2E(FRAME_LIMITS.e2eFromPhone + 1, phone.fp, mac.fp);
    expect(rejected.byteLength).toBe(FRAME_LIMITS.e2eFromPhone + 1);
    phoneConn.sendRaw(rejected);
    await expectClosed(phoneConn, 4413);
  });

  it("routes agent E2E at 1 MiB and rejects 1 MiB + 1", async () => {
    const { mac, phone, agent, phoneConn } = await setupPaired();
    const accepted = sizedE2E(FRAME_LIMITS.e2eFromAgent, mac.fp, phone.fp);
    expect(accepted.byteLength).toBe(FRAME_LIMITS.e2eFromAgent);
    agent.sendRaw(accepted);
    expect((await phoneConn.next()).t).toBe("e2e");

    const rejected = sizedE2E(FRAME_LIMITS.e2eFromAgent + 1, mac.fp, phone.fp);
    expect(rejected.byteLength).toBe(FRAME_LIMITS.e2eFromAgent + 1);
    agent.sendRaw(rejected);
    await expectClosed(agent, 4413);
  });

  it("does not mistake an E2E ciphertext containing the old ctrl signature for control", async () => {
    const { mac, phone, agent, phoneConn } = await setupPaired();
    const bytes = sizedE2E(FRAME_LIMITS.ctrl + 1, mac.fp, phone.fp, OLD_CTRL_SIGNATURE);
    expect(bytes.byteLength).toBe(FRAME_LIMITS.ctrl + 1);
    expect(signatureOffset(bytes, OLD_CTRL_SIGNATURE)).toBeGreaterThanOrEqual(0);
    expect(signatureOffset(bytes, OLD_CTRL_SIGNATURE)).toBeLessThanOrEqual(64);
    agent.sendRaw(bytes);

    const received = await phoneConn.next();
    expect(received.t).toBe("e2e");
    expect((received.body as { c: Uint8Array }).c.slice(0, OLD_CTRL_SIGNATURE.length)).toEqual(
      OLD_CTRL_SIGNATURE,
    );
    expect(decodeEnvelope(bytes).t).toBe("e2e");
  });
});
