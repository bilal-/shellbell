/**
 * One-use paired-v1 tunnel for the first v2 relay handshake. It never admits
 * terminal messages, even though its framing is v1 and protected by K_conn.
 * Endpoint route ownership and durable protocol-floor commit are separate.
 */
import { bytesEqual } from "./bytes.js";
import { decodeCbor, encodeCbor } from "./codec.js";
import { deriveConnKey, frameAd, helloAd, open, randomBytes, seal } from "./crypto.js";
import { E2EBodySchema, type Envelope, FpSchema } from "./envelope.js";
import { parseInner } from "./inner.js";
import type { V2PairKeys, V2Role, V2SecureSession } from "./session-v2.js";
import { V2RelayBootstrap } from "./session-v2-bootstrap.js";
import { V2_FEATURE } from "./session-v2-signaling.js";

type Stage = "phone:new" | "phone:hello" | "computer:hello" | "bootstrap" | "ready" | "closed";
const MAX_CARRIER_CIPHERTEXT_BYTES = 2_048;

export interface V2PairedCarrierOptions {
  role: V2Role;
  computerFp: string;
  phoneFp: string;
  keys: V2PairKeys;
  newId(): Uint8Array;
  /** Monotonic milliseconds, shared with the bootstrap coordinator. */
  now(): number;
  timeoutMs?: number;
}

export class V2PairedCarrier {
  private stage: Stage;
  private readonly pairKey: Uint8Array;
  private readonly bootstrap: V2RelayBootstrap;
  private readonly timeoutMs: number;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phoneNonce: Uint8Array | null = null;
  private connKey: Uint8Array | null = null;
  private connTag = "";
  private seqIn = 0;
  private seqOut = 0;

  constructor(private readonly options: V2PairedCarrierOptions) {
    FpSchema.parse(options.computerFp);
    FpSchema.parse(options.phoneFp);
    if (options.role !== "phone" && options.role !== "computer") throw new Error("invalid v2 role");
    if (options.keys.pairKey.length !== 32) throw new Error("invalid pair key");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("invalid v2 carrier timeout");
    }
    this.pairKey = options.keys.pairKey.slice();
    this.bootstrap = new V2RelayBootstrap(options);
    this.stage = options.role === "phone" ? "phone:new" : "computer:hello";
  }

  get ready(): boolean {
    return this.stage === "ready" && this.bootstrap.ready;
  }

  get closed(): boolean {
    return this.stage === "closed";
  }

  /** Only the phone initiates; both sides must explicitly advertise v2. */
  start(): Envelope {
    if (this.stage !== "phone:new") throw new Error("v2 carrier cannot start");
    try {
      this.startDeadline();
      this.phoneNonce = randomBytes(16);
      this.stage = "phone:hello";
      return this.hello(this.phoneNonce);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Returns only a hello or bootstrap reply, never a terminal payload. */
  receive(envelope: Envelope): Envelope | null {
    if (this.stage === "closed" || this.stage === "ready" || this.stage === "phone:new") {
      throw new Error("v2 carrier not receiving");
    }
    try {
      if (this.stage !== "computer:hello") this.checkDeadline();
      const sender = this.options.role === "phone" ? this.options.computerFp : this.options.phoneFp;
      const recipient =
        this.options.role === "phone" ? this.options.phoneFp : this.options.computerFp;
      if (
        envelope.v !== 1 ||
        envelope.t !== "e2e" ||
        envelope.from !== sender ||
        envelope.to !== recipient
      ) {
        throw new Error("v2 carrier peer mismatch");
      }
      const body = E2EBodySchema.parse(envelope.body);
      if (body.c.length < 16 || body.c.length > MAX_CARRIER_CIPHERTEXT_BYTES) {
        throw new Error("v2 carrier ciphertext exceeds bound");
      }
      if (this.stage === "phone:hello" || this.stage === "computer:hello") {
        if (envelope.seq !== 0) throw new Error("v2 carrier expected hello");
        const hello = parseInner(decodeCbor(open(this.pairKey, body, helloAd(sender, recipient))));
        if (hello.type !== "conn.hello" || !hello.features?.includes(V2_FEATURE)) {
          throw new Error("v2 carrier requires v2 hello intent");
        }
        if (this.stage === "computer:hello") {
          this.startDeadline();
          this.phoneNonce = hello.n.slice();
          const computerNonce = randomBytes(16);
          if (bytesEqual(this.phoneNonce, computerNonce)) throw new Error("reused hello nonce");
          this.deriveConnection(this.phoneNonce, computerNonce);
          this.stage = "bootstrap";
          return this.hello(computerNonce);
        }
        if (!this.phoneNonce || bytesEqual(this.phoneNonce, hello.n)) {
          throw new Error("invalid hello nonce");
        }
        this.deriveConnection(this.phoneNonce, hello.n);
        this.stage = "bootstrap";
        return this.frame(this.bootstrap.begin());
      }
      if (!this.connKey || envelope.seq !== this.seqIn + 1) {
        throw new Error("v2 carrier frame sequence mismatch");
      }
      const inner = parseInner(
        decodeCbor(
          open(this.connKey, body, frameAd(sender, recipient, this.connTag, envelope.seq)),
        ),
      );
      if (inner.type !== "session.v2.bootstrap") {
        throw new Error("v2 carrier rejects legacy terminal message");
      }
      this.seqIn = envelope.seq;
      const answer = this.bootstrap.receive(inner.bytes);
      if (this.bootstrap.ready) {
        this.stage = "ready";
        this.clearDeadline();
      }
      return answer ? this.frame(answer) : null;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  takeReadySession(): V2SecureSession {
    if (!this.ready) throw new Error("v2 carrier not confirmed");
    const session = this.bootstrap.takeReadySession();
    this.close();
    return session;
  }

  close(): void {
    if (this.stage === "closed") return;
    this.stage = "closed";
    this.clearDeadline();
    this.pairKey.fill(0);
    this.phoneNonce?.fill(0);
    this.phoneNonce = null;
    this.connKey?.fill(0);
    this.connKey = null;
    this.connTag = "";
    this.bootstrap.close();
  }

  private hello(nonce: Uint8Array): Envelope {
    const from = this.options.role === "phone" ? this.options.phoneFp : this.options.computerFp;
    const to = this.options.role === "phone" ? this.options.computerFp : this.options.phoneFp;
    return {
      v: 1,
      t: "e2e",
      from,
      to,
      seq: 0,
      body: seal(
        this.pairKey,
        encodeCbor({ type: "conn.hello", n: nonce, features: [V2_FEATURE] }),
        helloAd(from, to),
      ),
    };
  }

  private frame(bytes: Uint8Array): Envelope {
    if (!this.connKey || this.seqOut >= Number.MAX_SAFE_INTEGER) {
      throw new Error("v2 carrier unavailable");
    }
    const from = this.options.role === "phone" ? this.options.phoneFp : this.options.computerFp;
    const to = this.options.role === "phone" ? this.options.computerFp : this.options.phoneFp;
    const seq = ++this.seqOut;
    return {
      v: 1,
      t: "e2e",
      from,
      to,
      seq,
      body: seal(
        this.connKey,
        encodeCbor({ type: "session.v2.bootstrap", bytes }),
        frameAd(from, to, this.connTag, seq),
      ),
    };
  }

  private deriveConnection(phoneNonce: Uint8Array, computerNonce: Uint8Array): void {
    const derived = deriveConnKey(
      this.pairKey,
      phoneNonce,
      computerNonce,
      this.options.computerFp,
      this.options.phoneFp,
    );
    this.connKey = derived.kConn;
    this.connTag = derived.connTag;
  }

  private startDeadline(): void {
    this.startedAt = this.options.now();
    if (!Number.isFinite(this.startedAt)) throw new Error("invalid v2 carrier clock");
    this.timer = setTimeout(() => this.close(), this.timeoutMs);
  }

  private checkDeadline(): void {
    const now = this.options.now();
    if (
      this.startedAt === null ||
      !Number.isFinite(now) ||
      now < this.startedAt ||
      now - this.startedAt >= this.timeoutMs
    ) {
      throw new Error("v2 carrier handshake expired");
    }
  }

  private clearDeadline(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
