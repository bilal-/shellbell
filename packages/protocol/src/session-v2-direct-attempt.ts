import { hexToBytes } from "./bytes.js";
import { randomBytes } from "./crypto.js";
import type { V2PairKeys, V2Role, V2SecureSession } from "./session-v2.js";
import { V2DirectHandshake } from "./session-v2-direct-handshake.js";
import { type DirectSignal, V2_SIGNAL_LIMITS } from "./session-v2-signaling.js";

export interface NativeDirectPeer {
  offer(): Promise<void>;
  answer(sdp: string): Promise<void>;
  acceptAnswer(sdp: string): Promise<void>;
  candidate(candidate: string, mid: string | null, mlineIndex: number | null): Promise<void>;
  remoteCertificate(expected: Uint8Array): Promise<Uint8Array>;
  send(bytes: Uint8Array): boolean;
  close(): void;
}
export interface NativeDirectEvents {
  description(sdp: string, type: "offer" | "answer"): void;
  candidate(candidate: string, mid: string | null, mlineIndex: number | null): void;
  open(): void;
  message(bytes: Uint8Array): void;
  closed(): void;
}
export type NativeDirectFactory = (events: NativeDirectEvents) => Promise<NativeDirectPeer>;
type Offer = Extract<DirectSignal, { type: "direct.offer" }>;
type Candidate = { candidate: string; mid: string | null; mlineIndex: number | null };

interface DirectAttemptOptions {
  role: V2Role;
  keys: V2PairKeys;
  computerFp: string;
  phoneFp: string;
  relay: V2SecureSession["description"];
  generation: Uint8Array;
  offer?: Offer;
  native: NativeDirectFactory;
  current(): boolean;
  committed(): boolean;
  sendSignal(signal: DirectSignal): boolean;
  sent(length: number): void;
  received(length: number): void;
  ready(session: V2SecureSession): void;
  frame(session: V2SecureSession, bytes: Uint8Array): void;
  failed(reason: string): void;
}

function fingerprint(sdp: string): Uint8Array {
  const match = /^a=fingerprint:sha-256 ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})\r?$/im.exec(sdp);
  if (!match?.[1]) throw new Error("missing SHA-256 SDP fingerprint");
  return hexToBytes(match[1].replaceAll(":", ""));
}
function signalSdp(sdp: string): string {
  return `${sdp
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.length && !/^a=(?:candidate|remote-candidates|end-of-candidates)(?::|$)/i.test(line),
    )
    .join("\r\n")}\r\n`;
}

/** One native negotiation owns its callbacks, bounded queues, deadline and crypto cleanup. */
export class V2DirectAttempt {
  readonly offerId: Uint8Array;
  readonly generation: Uint8Array;
  private attemptId: Uint8Array | null;
  private peer: NativeDirectPeer | null = null;
  private phoneDtls: Uint8Array | null;
  private computerDtls: Uint8Array | null = null;
  private localSdp: string | null = null;
  private remoteSdp = false;
  private opened = false;
  private verifying = false;
  private sentDescription = false;
  private sentCandidates = 0;
  private receivedCandidates = 0;
  private pendingData: Uint8Array[] = [];
  private pendingLocal: Candidate[] = [];
  private pendingRemote: Array<Extract<DirectSignal, { type: "direct.candidate" }>> = [];
  private handshake: V2DirectHandshake | null = null;
  private secureSession: V2SecureSession | null = null;
  private closed = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: DirectAttemptOptions) {
    this.offerId = options.offer?.offerId.slice() ?? randomBytes(16);
    this.attemptId = options.offer ? randomBytes(16) : null;
    this.generation = options.generation.slice();
    this.phoneDtls = options.offer?.phoneDtls.slice() ?? null;
    this.timer = setTimeout(() => this.fail("timeout"), 15_000);
  }
  get session(): V2SecureSession | null {
    return this.secureSession;
  }
  get phase(): "cutover" | "noise" | "certificate" | "open" | "connecting" | "offer" | "native" {
    return this.secureSession
      ? "cutover"
      : this.handshake
        ? "noise"
        : this.verifying
          ? "certificate"
          : this.opened
            ? "open"
            : this.remoteSdp
              ? "connecting"
              : this.localSdp
                ? "offer"
                : "native";
  }
  private get active(): boolean {
    return !this.closed && this.options.current();
  }
  cancelDeadline(): void {
    clearTimeout(this.timer);
  }
  close(): void {
    if (this.closed) return;
    // Fence synchronous close callbacks before touching the native peer.
    this.closed = true;
    this.cancelDeadline();
    this.pendingData = [];
    this.pendingLocal = [];
    this.pendingRemote = [];
    this.handshake?.close();
    this.secureSession?.close();
    this.peer?.close();
  }
  send(bytes: Uint8Array): boolean {
    const admitted = this.active && (this.peer?.send(bytes) ?? false);
    if (admitted) this.options.sent(bytes.length);
    return admitted;
  }
  private fail(reason = "closed"): void {
    if (this.active) this.options.failed(reason);
  }
  async start(): Promise<void> {
    const events: NativeDirectEvents = {
      description: (sdp, type) => {
        if (this.active) this.description(sdp, type);
      },
      candidate: (candidate, mid, mlineIndex) => {
        if (!this.active) return;
        try {
          this.localCandidate({ candidate, mid, mlineIndex });
        } catch {
          this.fail("local-candidate");
        }
      },
      open: () => {
        if (!this.active) return;
        this.opened = true;
        void this.openDirect().catch(() => this.fail("certificate"));
      },
      message: (bytes) => {
        if (!this.active) return;
        this.options.received(bytes.length);
        this.directMessage(bytes);
      },
      closed: () => this.fail("native-closed"),
    };
    let peer: NativeDirectPeer;
    try {
      peer = await this.options.native(events);
    } catch {
      this.fail("native-create");
      return;
    }
    if (!this.active) {
      peer.close();
      return;
    }
    this.peer = peer;
    try {
      if (this.options.offer) {
        await peer.answer(this.options.offer.sdp);
        if (!this.active) return;
        this.remoteSdp = true;
      } else await peer.offer();
      if (!this.active) return;
      await this.flushRemote();
      await this.openDirect();
    } catch {
      this.fail("native-description");
    }
  }
  private description(sdp: string, type: "offer" | "answer"): void {
    try {
      const local = fingerprint(sdp);
      this.localSdp = signalSdp(sdp);
      if (this.options.role === "phone" && type === "offer") this.phoneDtls = local;
      else if (this.options.role === "computer" && type === "answer") this.computerDtls = local;
      else throw new Error("description role mismatch");
      const common = this.signalContext();
      const message: DirectSignal =
        type === "offer"
          ? { type: "direct.offer", ...common, phoneDtls: local, sdp: this.localSdp }
          : {
              type: "direct.answer",
              ...common,
              attemptId: this.attemptId!,
              computerDtls: local,
              sdp: this.localSdp,
            };
      if (!this.options.sendSignal(message)) throw new Error("signaling queue refused");
      this.sentDescription = true;
      for (const candidate of this.pendingLocal.splice(0)) this.localCandidate(candidate);
      void this.openDirect().catch(() => this.fail("certificate"));
    } catch {
      this.fail("local-description");
    }
  }
  private localCandidate(candidate: Candidate): void {
    if (!this.active || this.options.committed()) return;
    if (!this.sentDescription) {
      if (this.pendingLocal.length >= V2_SIGNAL_LIMITS.candidatesPerSide) this.fail();
      else this.pendingLocal.push(candidate);
      return;
    }
    if (
      this.sentCandidates >= V2_SIGNAL_LIMITS.candidatesPerSide ||
      !this.options.sendSignal({
        type: "direct.candidate",
        ...this.signalContext(),
        index: this.sentCandidates++,
        ...candidate,
      })
    )
      this.fail();
  }
  async signal(signal: Exclude<DirectSignal, Offer>): Promise<void> {
    if (!this.active || !this.peer) return;
    if (signal.type === "direct.answer") {
      if (this.remoteSdp) return;
      this.computerDtls = signal.computerDtls.slice();
      this.attemptId = signal.attemptId.slice();
      await this.peer.acceptAnswer(signal.sdp);
      if (!this.active) return;
      this.remoteSdp = true;
      await this.flushRemote();
      await this.openDirect();
    } else if (signal.type === "direct.candidate") {
      if (signal.index !== this.receivedCandidates++) throw new Error("candidate order");
      if (this.remoteSdp)
        await this.peer.candidate(signal.candidate, signal.mid, signal.mlineIndex);
      else this.pendingRemote.push(signal);
    } else if (signal.type === "direct.abort") this.fail();
  }
  private async flushRemote(): Promise<void> {
    if (!this.remoteSdp || !this.peer) return;
    for (const candidate of this.pendingRemote.splice(0)) {
      if (!this.active) return;
      await this.peer.candidate(candidate.candidate, candidate.mid, candidate.mlineIndex);
    }
  }
  signalContext() {
    return {
      sessionId: this.options.relay.sessionId,
      offerId: this.offerId,
      generation: this.generation,
    };
  }
  private async openDirect(): Promise<void> {
    if (
      !this.active ||
      !this.opened ||
      !this.peer ||
      !this.phoneDtls ||
      !this.computerDtls ||
      !this.attemptId ||
      this.verifying ||
      this.handshake ||
      this.secureSession
    )
      return;
    this.verifying = true;
    const actual = await this.peer.remoteCertificate(
      this.options.role === "phone" ? this.computerDtls : this.phoneDtls,
    );
    if (!this.active) return;
    this.handshake = new V2DirectHandshake(
      {
        route: "direct",
        computerFp: this.options.computerFp,
        phoneFp: this.options.phoneFp,
        sessionId: this.options.relay.sessionId,
        generation: this.generation,
        attemptId: this.attemptId,
        phoneDtls: this.phoneDtls,
        computerDtls: this.computerDtls,
      },
      this.options.role,
      this.options.keys,
      actual,
    );
    if (this.options.role === "phone" && !this.send(this.handshake.begin())) {
      this.fail();
      return;
    }
    for (const bytes of this.pendingData.splice(0)) this.directMessage(bytes);
  }
  private directMessage(bytes: Uint8Array): void {
    if (!this.active) return;
    try {
      if (!this.peer || bytes.length > 61_000) throw new Error("direct frame bounds");
      if (this.secureSession) {
        this.options.frame(this.secureSession, bytes);
        return;
      }
      if (!this.handshake) {
        if (!this.verifying || this.pendingData.length >= 4 || bytes.length > 1_024)
          throw new Error("direct handshake missing");
        this.pendingData.push(bytes.slice());
        return;
      }
      const answer = this.handshake.receive(bytes);
      if (answer && !this.send(answer)) throw new Error("direct queue refused");
      if (this.handshake.ready) {
        this.secureSession = this.handshake.takeReadySession();
        this.handshake = null;
        this.options.ready(this.secureSession);
      }
    } catch {
      this.fail("direct-frame");
    }
  }
}
