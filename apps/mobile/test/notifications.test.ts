import {
  type CtrlMessageLoose,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  parseCtrlLoose,
  randomBytes,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { ComputerConnection } from "../src/net/connection";
import { installNativePushTokenListener } from "../src/notifications/native-token";
import {
  createTapHandler,
  foregroundToast,
  type NavTarget,
  parseDeepLink,
  resolveTarget,
} from "../src/notifications/routing";
import { sidToRoute } from "../src/util/routes";

const PAIRED = "a".repeat(26);
const OTHER = "b".repeat(26);

describe("resolveTarget (spec 11.1: validate computerFp before navigating)", () => {
  it("routes a paired computer with a session", () => {
    expect(
      resolveTarget({ computerFp: PAIRED, sessionId: "iterm2:w0t0p0", kind: "prompt" }, [PAIRED]),
    ).toEqual({ computerFp: PAIRED, sessionRoute: sidToRoute("iterm2:w0t0p0") });
  });

  it("routes a paired computer with no session", () => {
    expect(resolveTarget({ computerFp: PAIRED }, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: null,
    });
  });

  it("ignores a computer this phone is not paired with", () => {
    expect(resolveTarget({ computerFp: OTHER, sessionId: "s" }, [PAIRED])).toBeNull();
  });

  it("ignores a malformed fingerprint even when the list is empty-checked loosely", () => {
    expect(resolveTarget({ computerFp: "NOT-A-FP" }, ["NOT-A-FP"])).toBeNull();
    expect(resolveTarget({ computerFp: `${PAIRED}x` }, [`${PAIRED}x`])).toBeNull();
  });

  it("ignores junk payloads", () => {
    for (const junk of [null, undefined, 42, "string", [], {}, { computerFp: 7 }]) {
      expect(resolveTarget(junk, [PAIRED])).toBeNull();
    }
  });
});

describe("parseDeepLink", () => {
  it("parses a computer link and a session link", () => {
    expect(parseDeepLink(`shellbell://c/${PAIRED}`, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: null,
    });
    const route = sidToRoute("tmux:%3");
    expect(parseDeepLink(`shellbell://c/${PAIRED}/s/${route}`, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: route,
    });
  });

  it("rejects other schemes, unpaired computers, and non-base64url session segments", () => {
    expect(parseDeepLink(`https://c/${PAIRED}`, [PAIRED])).toBeNull();
    expect(parseDeepLink(`shellbell://c/${OTHER}`, [PAIRED])).toBeNull();
    expect(parseDeepLink(`shellbell://c/${PAIRED}/s/has spaces`, [PAIRED])).toBeNull();
    expect(parseDeepLink("shellbell://pair", [PAIRED])).toBeNull();
  });
});

describe("foregroundToast (spec 10.8 / 8.13)", () => {
  it("maps every ringing kind, including blocked", () => {
    expect(foregroundToast("build", "prompt")).toBe("build: command finished");
    expect(foregroundToast("build", "idle")).toBe("build: went quiet — waiting?");
    expect(foregroundToast("claude", "blocked")).toBe("claude: an agent is waiting for you");
  });

  it("stays silent for exit and unknown kinds", () => {
    expect(foregroundToast("build", "exit")).toBeNull();
    expect(foregroundToast("build", "bell")).toBeNull();
  });
});

describe("createTapHandler", () => {
  it("opens only validated targets and re-reads the paired list on every tap", () => {
    const opened: NavTarget[] = [];
    let paired: string[] = [];
    const handle = createTapHandler(
      (t) => opened.push(t),
      () => paired,
    );
    handle({ computerFp: PAIRED });
    expect(opened).toHaveLength(0);
    paired = [PAIRED];
    handle({ computerFp: PAIRED });
    handle({ computerFp: OTHER });
    expect(opened).toEqual([{ computerFp: PAIRED, sessionRoute: null }]);
  });
});

/** A recording `WsLike` double — same shape as the one in `connection.test.ts`. */
class RecordingSocket {
  binaryType = "";
  readyState = 0;
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") return;
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  ctrl(body: CtrlMessageLoose): void {
    const env: Envelope = { v: 1, t: "ctrl", from: "relay", seq: 0, body } as Envelope;
    this.onmessage?.({ data: encodeEnvelope(env) });
  }

  ctrlsSent(): CtrlMessageLoose[] {
    const out: CtrlMessageLoose[] = [];
    for (const bytes of this.sent) {
      const env = decodeEnvelope(bytes);
      if (env.t === "ctrl") out.push(parseCtrlLoose(env.body));
    }
    return out;
  }
}

describe("token -> push-token ctrl (spec 10.8)", () => {
  it("sends the provider's token on auth-ok", async () => {
    const identity = generateIdentity();
    const phoneFp = fingerprint(identity.ed25519.pub);
    let socket: RecordingSocket | null = null;
    const conn = new ComputerConnection({
      computerFp: "c".repeat(26),
      relayUrl: "wss://relay.example",
      identity,
      phoneFp,
      phoneName: "Test phone",
      appVersion: "0.1.0",
      kPair: randomBytes(32),
      pushToken: async () => ({
        token: "native-token",
        platform: "android",
        provider: "fcm",
        enabled: true,
      }),
      onInner: () => undefined,
      onStatus: () => undefined,
      WebSocketImpl: class extends RecordingSocket {
        constructor(url: string) {
          super(url);
          socket = this;
        }
      },
    });
    conn.connect();
    const s = socket as RecordingSocket | null;
    if (s === null) throw new Error("socket was not created");
    s.open();
    s.ctrl({ type: "challenge", nonce: randomBytes(32), connId: "conn-1" });
    s.ctrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: false,
      computerName: "MBP",
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    await expect.poll(() => s.ctrlsSent().some((m) => m.type === "push-token")).toBe(true);
    const pushCtrl = s.ctrlsSent().find((m) => m.type === "push-token");
    expect(pushCtrl).toEqual({
      type: "push-token",
      token: "native-token",
      platform: "android",
      provider: "fcm",
      enabled: true,
    });
    let tokenChanged: (token: string) => void = () => {};
    const offToken = installNativePushTokenListener(
      (token) => conn.sendPushToken({ ...token, enabled: true }),
      {
        platform: "android",
        getPermissions: async () => ({ granted: true }),
        getDevicePushToken: async () => "unused",
        getIosEnvironment: async () => null,
        onToken: (cb) => {
          tokenChanged = cb;
          return () => {};
        },
      },
    );
    tokenChanged("replacement-native-token");
    await expect
      .poll(() => s.ctrlsSent().at(-1))
      .toEqual({
        type: "push-token",
        token: "replacement-native-token",
        platform: "android",
        provider: "fcm",
        enabled: true,
      });
    offToken();
    conn.close("user");
  });
});
