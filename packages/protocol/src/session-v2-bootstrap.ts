/** Isolated relay-route bootstrap. Endpoint wiring and route commit are separate release gates. */
import { bytesEqual } from "./bytes.js";
import { FpSchema } from "./envelope.js";
import {
  createV2Handshake,
  decodeV2Frame,
  encodeV2Frame,
  type V2Handshake,
  V2IdSchema,
  type V2PairKeys,
  type V2Role,
  type V2SecureSession,
  type V2SessionContext,
} from "./session-v2.js";
import { decodeV2Bootstrap, encodeV2Bootstrap } from "./session-v2-signaling.js";

const GENERATION_ONE = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0);
const DEFAULT_TIMEOUT_MS = 15_000;
type Stage =
  | "phone:new"
  | "phone:accept"
  | "phone:noise2"
  | "phone:confirm"
  | "computer:begin"
  | "computer:noise1"
  | "computer:confirm"
  | "ready"
  | "detached"
  | "closed";

export interface V2RelayBootstrapOptions {
  role: V2Role;
  computerFp: string;
  phoneFp: string;
  keys: V2PairKeys;
  newId(): Uint8Array;
  /** Supply a monotonic millisecond clock. */
  now(): number;
  timeoutMs?: number;
}

/** Owns exactly one handshake attempt and never accepts terminal data itself. */
export class V2RelayBootstrap {
  private stage: Stage;
  private startedAt: number | null = null;
  private sessionId: Uint8Array | null = null;
  private attemptId: Uint8Array | null = null;
  private handshake: V2Handshake | null = null;
  private session: V2SecureSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly keys: V2PairKeys;
  private readonly timeoutMs: number;

  constructor(private readonly options: V2RelayBootstrapOptions) {
    FpSchema.parse(options.computerFp);
    FpSchema.parse(options.phoneFp);
    if (options.role !== "phone" && options.role !== "computer") throw new Error("invalid v2 role");
    if (
      options.keys.staticPrivate.length !== 32 ||
      options.keys.remoteStatic.length !== 32 ||
      options.keys.pairKey.length !== 32
    )
      throw new Error("invalid v2 pairing keys");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error("invalid v2 bootstrap timeout");
    }
    this.keys = {
      staticPrivate: options.keys.staticPrivate.slice(),
      remoteStatic: options.keys.remoteStatic.slice(),
      pairKey: options.keys.pairKey.slice(),
    };
    this.stage = options.role === "phone" ? "phone:new" : "computer:begin";
  }

  get ready(): boolean {
    return this.stage === "ready" && this.session?.ready === true;
  }

  begin(): Uint8Array {
    if (this.stage !== "phone:new") throw new Error("v2 begin not allowed");
    try {
      this.startedAt = this.clock();
      this.armTimer();
      this.sessionId = this.freshId();
      this.stage = "phone:accept";
      return encodeV2Bootstrap({
        type: "session.v2.begin",
        sessionId: this.sessionId,
        generation: GENERATION_ONE,
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  receive(bytes: Uint8Array): Uint8Array | null {
    try {
      if (this.stage === "closed" || this.stage === "detached" || this.stage === "ready") {
        throw new Error("v2 bootstrap no longer accepts messages");
      }
      if (this.stage !== "computer:begin") this.assertNotExpired();
      switch (this.stage) {
        case "computer:begin": {
          const begin = decodeV2Bootstrap(bytes, {
            sender: "phone",
            expectedType: "session.v2.begin",
          });
          if (begin.type !== "session.v2.begin") throw new Error("invalid v2 begin");
          this.startedAt = this.clock();
          this.armTimer();
          this.sessionId = begin.sessionId.slice();
          this.attemptId = this.freshId();
          if (bytesEqual(this.sessionId, this.attemptId)) throw new Error("repeated v2 attempt ID");
          this.handshake = this.newHandshake();
          this.stage = "computer:noise1";
          return encodeV2Bootstrap({
            type: "session.v2.accept",
            sessionId: this.sessionId,
            attemptId: this.attemptId,
            generation: GENERATION_ONE,
          });
        }
        case "phone:accept": {
          const accept = decodeV2Bootstrap(bytes, {
            sender: "computer",
            expectedType: "session.v2.accept",
            sessionId: this.requireSessionId(),
          });
          if (accept.type !== "session.v2.accept") throw new Error("invalid v2 accept");
          this.attemptId = accept.attemptId.slice();
          if (bytesEqual(this.requireSessionId(), this.attemptId)) {
            throw new Error("repeated v2 attempt ID");
          }
          this.handshake = this.newHandshake();
          const message = this.handshake.write();
          this.stage = "phone:noise2";
          return encodeV2Bootstrap({
            type: "session.v2.noise1",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
            message,
          });
        }
        case "computer:noise1": {
          const noise1 = decodeV2Bootstrap(bytes, {
            sender: "phone",
            expectedType: "session.v2.noise1",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
          });
          if (noise1.type !== "session.v2.noise1" || !this.handshake)
            throw new Error("invalid v2 noise1");
          this.handshake.read(noise1.message);
          const message = this.handshake.write();
          this.session = this.handshake.finish();
          this.handshake = null;
          this.stage = "computer:confirm";
          return encodeV2Bootstrap({
            type: "session.v2.noise2",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
            message,
          });
        }
        case "phone:noise2": {
          const noise2 = decodeV2Bootstrap(bytes, {
            sender: "computer",
            expectedType: "session.v2.noise2",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
          });
          if (noise2.type !== "session.v2.noise2" || !this.handshake)
            throw new Error("invalid v2 noise2");
          this.handshake.read(noise2.message);
          this.session = this.handshake.finish();
          this.handshake = null;
          const frame = encodeV2Frame(this.session.confirmation());
          this.stage = "phone:confirm";
          return encodeV2Bootstrap({
            type: "session.v2.confirm",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
            frame,
          });
        }
        case "computer:confirm": {
          const confirm = this.decodeConfirmation(bytes, "phone");
          if (!this.session) throw new Error("v2 session missing");
          this.session.acceptConfirmation(decodeV2Frame(confirm.frame));
          const frame = encodeV2Frame(this.session.confirmation());
          if (!this.session.ready) throw new Error("v2 computer confirmation incomplete");
          this.markReady();
          return encodeV2Bootstrap({
            type: "session.v2.confirm",
            sessionId: this.requireSessionId(),
            attemptId: this.requireAttemptId(),
            frame,
          });
        }
        case "phone:confirm": {
          const confirm = this.decodeConfirmation(bytes, "computer");
          if (!this.session) throw new Error("v2 session missing");
          this.session.acceptConfirmation(decodeV2Frame(confirm.frame));
          if (!this.session.ready) throw new Error("v2 phone confirmation incomplete");
          this.markReady();
          return null;
        }
        default:
          throw new Error("invalid v2 bootstrap stage");
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  takeReadySession(): V2SecureSession {
    if (!this.ready || !this.session) throw new Error("v2 session not confirmed");
    const session = this.session;
    this.session = null;
    this.stage = "detached";
    return session;
  }

  close(): void {
    if (this.stage === "closed") return;
    this.stage = "closed";
    this.clearTimer();
    this.handshake?.close();
    this.handshake = null;
    this.session?.close();
    this.session = null;
    this.keys.staticPrivate.fill(0);
    this.keys.remoteStatic.fill(0);
    this.keys.pairKey.fill(0);
  }

  private decodeConfirmation(bytes: Uint8Array, sender: V2Role) {
    const message = decodeV2Bootstrap(bytes, {
      sender,
      expectedType: "session.v2.confirm",
      sessionId: this.requireSessionId(),
      attemptId: this.requireAttemptId(),
    });
    if (message.type !== "session.v2.confirm") throw new Error("invalid v2 confirmation");
    return message;
  }

  private newHandshake(): V2Handshake {
    const context: V2SessionContext = {
      route: "relay",
      computerFp: this.options.computerFp,
      phoneFp: this.options.phoneFp,
      sessionId: this.requireSessionId(),
      attemptId: this.requireAttemptId(),
      generation: GENERATION_ONE,
    };
    try {
      return createV2Handshake(context, this.options.role, this.keys);
    } finally {
      this.keys.staticPrivate.fill(0);
      this.keys.remoteStatic.fill(0);
      this.keys.pairKey.fill(0);
    }
  }

  private freshId(): Uint8Array {
    return V2IdSchema.parse(this.options.newId()).slice();
  }
  private requireSessionId(): Uint8Array {
    if (!this.sessionId) throw new Error("v2 session ID missing");
    return this.sessionId;
  }
  private requireAttemptId(): Uint8Array {
    if (!this.attemptId) throw new Error("v2 attempt ID missing");
    return this.attemptId;
  }
  private clock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now) || now < 0) throw new Error("invalid v2 clock");
    return now;
  }
  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.close(), this.timeoutMs);
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private markReady(): void {
    this.stage = "ready";
    this.clearTimer();
  }
  private assertNotExpired(): void {
    if (this.startedAt === null) throw new Error("v2 bootstrap not started");
    const elapsed = this.clock() - this.startedAt;
    if (elapsed < 0 || elapsed > this.timeoutMs) throw new Error("v2 bootstrap expired");
  }
}
