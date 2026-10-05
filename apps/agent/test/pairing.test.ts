import {
  type CtrlMessage,
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  MAX_PAIRINGS,
  open,
  pairingAd,
  parseQr,
  seal,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Pairing } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { PairingManagerOptions } from "../src/pairing.js";
import { PairingManager } from "../src/pairing.js";

function setup(
  confirm: (fp: string, name: string) => Promise<boolean>,
  overrides: Partial<PairingManagerOptions> = {},
) {
  const identity = generateIdentity();
  const fp = fingerprint(identity.ed25519.pub);
  const sent: CtrlMessage[] = [];
  const saved: Pairing[] = [];
  let t = 0;
  /** Simulates `RelayClient.sendCtrl`'s return value: false while "unauthenticated"/offline. */
  let sendOk = true;
  const pm = new PairingManager({
    identity,
    fp,
    computerName: "MBP",
    accent: "emerald",
    relayUrl: "wss://relay.test",
    sendCtrl: (m) => {
      sent.push(m);
      return sendOk;
    },
    savePairing: (p) => saved.push(p),
    confirm,
    pairingCount: () => 0,
    log: createLogger({ stdout: false }),
    now: () => t,
    ...overrides,
  });
  return {
    pm,
    identity,
    fp,
    sent,
    saved,
    advance: (ms: number) => {
      t += ms;
      pm.tick();
    },
    setSendOk: (ok: boolean) => {
      sendOk = ok;
    },
  };
}

function phoneRequestBody(
  qrText: string,
  body: Record<string, unknown>,
  phone = generateIdentity(),
) {
  const qr = parseQr(qrText);
  const code = fromBase64Url(qr.p);
  const phoneFp = fingerprint(phone.ed25519.pub);
  const kPsk = derivePskKey(code, qr.c);
  const box = seal(kPsk, encodeCbor(body), pairingAd("request", qr.c, phoneFp));
  return {
    phone,
    phoneFp,
    code,
    kPsk,
    qr,
    msg: { type: "pairing-request" as const, phoneFp, box },
  };
}

function phoneRequest(qrText: string, phone = generateIdentity()) {
  return phoneRequestBody(
    qrText,
    {
      ed25519Pub: phone.ed25519.pub,
      x25519Pub: phone.x25519.pub,
      name: "iPhone",
      platform: "ios",
    },
    phone,
  );
}

describe("PairingManager", () => {
  it("releases a closed window's pending attempt without letting its late result affect a reopened same-fingerprint request", async () => {
    let resolveOld!: (value: boolean) => void;
    let resolveNew!: (value: boolean) => void;
    let calls = 0;
    const { pm, sent, saved } = setup(
      () =>
        new Promise<boolean>((resolve) => {
          calls += 1;
          if (calls === 1) resolveOld = resolve;
          else resolveNew = resolve;
        }),
    );
    const phone = generateIdentity();
    const first = pm.openWindow();
    const oldRequest = pm.handleRequest(phoneRequest(first.qrText, phone).msg);
    await vi.waitFor(() => expect(calls).toBe(1));
    pm.closeWindow();
    const second = pm.openWindow();
    const newRequest = pm.handleRequest(phoneRequest(second.qrText, phone).msg);
    await vi.waitFor(() => expect(calls).toBe(2));

    // An obsolete accepted completion must be as inert as an obsolete decline: it
    // cannot save/pair/reject a replacement attempt sharing this fingerprint.
    resolveOld(true);
    await oldRequest;
    expect(sent.filter((message) => message.type === "pairing-reject")).toHaveLength(0);
    expect(sent.filter((message) => message.type === "pairing-add")).toHaveLength(0);
    expect(sent.filter((message) => message.type === "pairing-response")).toHaveLength(0);
    expect(saved).toEqual([]);
    expect(pm.isOpen).toBe(true);

    resolveNew(true);
    await newRequest;
    expect(sent.filter((message) => message.type === "pairing-reject")).toHaveLength(0);
    expect(sent.filter((message) => message.type === "pairing-add")).toHaveLength(1);
    expect(sent.filter((message) => message.type === "pairing-response")).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.phoneFp).toBe(fingerprint(phone.ed25519.pub));
  });
  it("opens a window: QR carries relay, fp, pub, name, code, gate; relay gets gateHash", () => {
    const { pm, fp, identity, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const qr = parseQr(qrText);
    expect(qr.c).toBe(fp);
    expect(qr.e).toBe(toBase64Url(identity.ed25519.pub));
    expect(qr.r).toBe("wss://relay.test");
    const opened = sent[0];
    if (opened?.type !== "pairing-open") throw new Error();
    expect(opened.gateHash).toEqual(sha256(fromBase64Url(qr.g)));
    expect(pm.isOpen).toBe(true);
  });

  it("accepts a valid request after confirmation and derives the same K_pair as the phone", async () => {
    const confirmed: string[] = [];
    const { pm, identity, fp, sent, saved } = setup(async (pfp, name) => {
      confirmed.push(`${name}:${pfp.slice(0, 4)}`);
      return true;
    });
    const { qrText } = pm.openWindow();
    const req = phoneRequest(qrText);
    await pm.handleRequest(req.msg);
    expect(confirmed).toHaveLength(1);
    const types = sent.map((m) => m.type);
    expect(types).toEqual(["pairing-open", "pairing-add", "pairing-response", "pairing-close"]);
    const resp = sent[2];
    if (resp?.type !== "pairing-response") throw new Error();
    const inner = decodeCbor(open(req.kPsk, resp.box, pairingAd("response", fp, req.phoneFp))) as {
      x25519Pub: Uint8Array;
      computerName: string;
      accent: string;
    };
    expect(inner.computerName).toBe("MBP");
    const phoneK = derivePairKey(req.phone.x25519.priv, inner.x25519Pub, req.code, fp, req.phoneFp);
    expect(fromBase64Url(saved[0]?.kPair ?? "")).toEqual(phoneK);
    expect(saved[0]?.phoneFp).toBe(req.phoneFp);
    expect(pm.isOpen).toBe(false);
    void identity;
  });

  it("declined confirmation → pairing-reject declined, window stays open", async () => {
    const { pm, sent } = setup(async () => false);
    const { qrText } = pm.openWindow();
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "declined" });
    expect(pm.isOpen).toBe(true);
  });

  it("bad code → reject bad-code; three failures close the window", async () => {
    const { pm, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const good = parseQr(qrText);
    const badQr = JSON.stringify({ ...good, p: toBase64Url(new Uint8Array(16).fill(9)) });
    for (let i = 0; i < 3; i++) await pm.handleRequest(phoneRequest(badQr).msg);
    const rejects = sent.filter((m) => m.type === "pairing-reject");
    expect(rejects).toHaveLength(3);
    expect(rejects[0]).toMatchObject({ reason: "bad-code" });
    expect(pm.isOpen).toBe(false);
    expect(sent.at(-1)?.type).toBe("pairing-close");
  });

  it("expires after the window and rejects late requests with window-closed", async () => {
    const { pm, sent, advance } = setup(async () => true);
    const { qrText } = pm.openWindow();
    advance(300_001);
    expect(pm.isOpen).toBe(false);
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "window-closed" });
  });

  it("wrong-length x25519Pub → bad-code, no throw, window stays open", async () => {
    const { pm, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const phone = generateIdentity();
    const req = phoneRequestBody(
      qrText,
      {
        ed25519Pub: phone.ed25519.pub,
        x25519Pub: phone.x25519.pub.slice(0, 16),
        name: "iPhone",
        platform: "ios",
      },
      phone,
    );
    await expect(pm.handleRequest(req.msg)).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "bad-code" });
    expect(pm.isOpen).toBe(true);
  });

  it("low-order x25519Pub (all-zero) → bad-code after confirmation, no throw, window stays open", async () => {
    const { pm, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const phone = generateIdentity();
    const req = phoneRequestBody(
      qrText,
      {
        ed25519Pub: phone.ed25519.pub,
        x25519Pub: new Uint8Array(32),
        name: "iPhone",
        platform: "ios",
      },
      phone,
    );
    await expect(pm.handleRequest(req.msg)).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "bad-code" });
    expect(pm.isOpen).toBe(true);
  });

  it("concurrent pairing-requests: the second is rejected too-many with no second prompt", async () => {
    let resolveConfirm: (ok: boolean) => void = () => {};
    const confirmCalls: string[] = [];
    const { pm, sent } = setup((phoneFp, name) => {
      confirmCalls.push(`${name}:${phoneFp.slice(0, 4)}`);
      return new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
    });
    const { qrText } = pm.openWindow();
    const req1 = phoneRequest(qrText);
    const req2 = phoneRequest(qrText);
    const p1 = pm.handleRequest(req1.msg);
    // req1 is now suspended awaiting confirm(); req2 must not trigger a second prompt.
    await pm.handleRequest(req2.msg);
    expect(confirmCalls).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({
      type: "pairing-reject",
      phoneFp: req2.phoneFp,
      reason: "too-many",
    });
    resolveConfirm(true);
    await p1;
    expect(sent.some((m) => m.type === "pairing-response")).toBe(true);
  });

  it("confirmation prompt times out after confirmTimeoutMs → pairing-reject declined", async () => {
    vi.useFakeTimers();
    try {
      const { pm, sent } = setup(() => new Promise<boolean>(() => {}), {
        confirmTimeoutMs: 60_000,
      });
      const { qrText } = pm.openWindow();
      const req = pm.handleRequest(phoneRequest(qrText).msg);
      await vi.advanceTimersByTimeAsync(60_000);
      await req;
      expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "declined" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("agent-side pairing cap: rejects too-many before prompting once at MAX_PAIRINGS", async () => {
    const confirmCalls: string[] = [];
    const { pm, sent } = setup(
      async (phoneFp, name) => {
        confirmCalls.push(`${name}:${phoneFp.slice(0, 4)}`);
        return true;
      },
      { pairingCount: () => MAX_PAIRINGS },
    );
    const { qrText } = pm.openWindow();
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(confirmCalls).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "too-many" });
    expect(pm.isOpen).toBe(true);
  });

  it("openWindow() while already open closes the previous window first", () => {
    const { pm, sent } = setup(async () => true);
    pm.openWindow();
    pm.openWindow();
    const types = sent.map((m) => m.type);
    expect(types).toEqual(["pairing-open", "pairing-close", "pairing-open"]);
  });

  it("openWindow() throws if the built QR payload does not round-trip (bad relay URL)", () => {
    const { pm } = setup(async () => true, { relayUrl: "http://relay.test" });
    expect(() => pm.openWindow()).toThrow();
  });

  it("openWindow() accepts a ws:// relayUrl (dev override) and the QR carries it (I2)", () => {
    const { pm, sent } = setup(async () => true, { relayUrl: "ws://localhost:8787" });
    const { qrText } = pm.openWindow();
    expect(parseQr(qrText, { allowInsecure: true }).r).toBe("ws://localhost:8787");
    expect(sent[0]).toMatchObject({ type: "pairing-open" });
  });

  describe("readvertise() (C1/I1: pairing window survives auth/reconnect)", () => {
    it("re-sends pairing-open for the still-open window once sendCtrl can succeed", () => {
      const { pm, sent, setSendOk } = setup(async () => true);
      // Simulate the relay socket not being authenticated yet: openWindow()'s own send is
      // dropped, exactly like RelayClient.sendCtrl returning false pre-auth.
      setSendOk(false);
      const { qrText, expiresAt } = pm.openWindow();
      const qr = parseQr(qrText);
      expect(sent).toHaveLength(1); // the dropped attempt was still made once
      // Now the relay authenticates -- Agent's auth-ok handler calls readvertise().
      setSendOk(true);
      pm.readvertise();
      const opened = sent.filter((m) => m.type === "pairing-open");
      expect(opened).toHaveLength(2);
      const last = opened.at(-1);
      if (last?.type !== "pairing-open") throw new Error();
      expect(last.gateHash).toEqual(sha256(fromBase64Url(qr.g)));
      expect(last.expiresAt).toBe(expiresAt);
      expect(pm.isOpen).toBe(true);
    });

    it("does not re-advertise once five requests were seen in the window (admission cap)", async () => {
      const { pm, sent } = setup(async () => false); // every request is declined
      const { qrText } = pm.openWindow();
      for (let i = 0; i < 5; i++) await pm.handleRequest(phoneRequest(qrText).msg);
      expect(pm.isOpen).toBe(true);
      pm.readvertise();
      expect(sent.filter((m) => m.type === "pairing-open")).toHaveLength(1);
      expect(sent.filter((m) => m.type === "pairing-close")).toHaveLength(1);
      expect(pm.isOpen).toBe(false);
    });

    it("readvertising after a reconnect still lets a phone pair (regression for I1)", async () => {
      const { pm, sent, setSendOk } = setup(async () => true);
      const { qrText } = pm.openWindow();
      // A mid-window reconnect: the socket drops (nothing more sent) and comes back.
      setSendOk(false);
      setSendOk(true);
      pm.readvertise();
      expect(sent.filter((m) => m.type === "pairing-open")).toHaveLength(2);
      const req = phoneRequest(qrText);
      await pm.handleRequest(req.msg);
      expect(sent.some((m) => m.type === "pairing-response")).toBe(true);
    });

    it("does not re-send once the window has expired", () => {
      const { pm, sent, advance } = setup(async () => true);
      pm.openWindow();
      advance(300_001);
      expect(pm.isOpen).toBe(false);
      const before = sent.length;
      pm.readvertise();
      expect(sent).toHaveLength(before); // no additional pairing-open
    });

    it("is a no-op when no window has ever been opened", () => {
      const { pm, sent } = setup(async () => true);
      pm.readvertise();
      expect(sent).toHaveLength(0);
    });
  });
});
