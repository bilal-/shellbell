import {
  createPairRevocationV2,
  decodeEnvelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  randomBytes,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { RevocationOutbox } from "../src/identity/revocation-outbox";
import {
  createRevocationRetry,
  drainRevocationOutbox,
  submitRevocationProof,
} from "../src/net/revocation-delivery";

function fixture() {
  const phone = generateIdentity();
  const computer = generateIdentity();
  const proof = createPairRevocationV2({
    computerFp: fingerprint(computer.ed25519.pub),
    phoneFp: fingerprint(phone.ed25519.pub),
    kPair: randomBytes(32),
    phoneEd25519Priv: phone.ed25519.priv,
    phoneEd25519Pub: phone.ed25519.pub,
  });
  return { proof, phoneEd25519Pub: phone.ed25519.pub, relayUrl: "wss://relay.example.test" };
}

class FakeSocket {
  binaryType = "";
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(body: unknown) {
    this.onmessage?.({ data: encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }) });
  }
}

describe("proof-only revocation retry", () => {
  it("runs another pass immediately when a new proof arrives during a drain", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const retry = createRevocationRetry(async () => {
      calls += 1;
      if (calls === 1) await blocked;
    });
    const first = retry();
    const second = retry();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
  it("sends only after challenge and accepts a matching durable receipt", async () => {
    const entry = fixture();
    const socket = new FakeSocket();
    const result = submitRevocationProof(entry, () => socket);
    socket.onopen?.();
    expect(socket.sent).toHaveLength(0);
    socket.receive({ type: "challenge", connId: "c", nonce: randomBytes(32) });
    expect(decodeEnvelope(socket.sent[0]!).body).toEqual({
      type: "revocation-submit",
      phoneEd25519Pub: entry.phoneEd25519Pub,
      proof: entry.proof,
    });
    socket.receive({
      type: "revocation-receipt",
      phoneFp: entry.proof.phoneFp,
      pairId: randomBytes(32),
      status: "stored",
    });
    expect(socket.readyState).toBe(1);
    socket.receive({
      type: "revocation-receipt",
      phoneFp: entry.proof.phoneFp,
      pairId: entry.proof.pairId,
      status: "stored",
    });
    await expect(result).resolves.toBe("stored");
  });

  it("retains proof across failed attempt and removes only after receipt", async () => {
    const rows = new Map<string, string>();
    const outbox = new RevocationOutbox({
      getItemSync: (key) => rows.get(key) ?? null,
      setItemSync: (key, value) => {
        rows.set(key, value);
      },
    });
    const entry = fixture();
    outbox.put(entry);
    const failed = new FakeSocket();
    const first = drainRevocationOutbox(outbox, () => failed);
    failed.onclose?.();
    await first;
    expect(outbox.list()).toHaveLength(1);
    const retried = new FakeSocket();
    const second = drainRevocationOutbox(outbox, () => retried);
    retried.receive({ type: "challenge", connId: "c", nonce: randomBytes(32) });
    retried.receive({
      type: "revocation-receipt",
      phoneFp: entry.proof.phoneFp,
      pairId: entry.proof.pairId,
      status: "stored",
    });
    await second;
    expect(outbox.list()).toEqual([]);
  });

  it("retains proof when an older relay row lacks the current pair ID", async () => {
    const rows = new Map<string, string>();
    const outbox = new RevocationOutbox({
      getItemSync: (key) => rows.get(key) ?? null,
      setItemSync: (key, value) => {
        rows.set(key, value);
      },
    });
    const entry = fixture();
    outbox.put(entry);
    const socket = new FakeSocket();
    const attempt = drainRevocationOutbox(outbox, () => socket);
    socket.receive({ type: "challenge", connId: "c", nonce: randomBytes(32) });
    socket.receive({
      type: "revocation-receipt",
      phoneFp: entry.proof.phoneFp,
      pairId: entry.proof.pairId,
      status: "unavailable",
    });
    await attempt;
    expect(outbox.list()).toHaveLength(1);
  });
});
