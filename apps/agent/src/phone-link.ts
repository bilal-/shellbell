import {
  BOUNDED_STREAM_FEATURE,
  bytesEqual,
  decodeCbor,
  deriveConnKey,
  E2EBodySchema,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  FRAME_LIMITS,
  frameAd,
  helloAd,
  type InnerMessage,
  type InnerMessageOf,
  open,
  ProtocolError,
  parseInner,
  randomBytes,
  STREAM_LIMITS,
  seal,
} from "@shellbell/protocol";
import { type Logger, safeErrorName } from "./log.js";

export interface PhoneLinkOptions {
  phoneFp: string;
  connId: string;
  name: string;
  kPair: Uint8Array;
  computerFp: string;
  boundedStream?: boolean;
  /** This link only speaks v1; never let its hello reset an upgraded pair. */
  minProtocolVersion?: 2;
  // biome-ignore lint/suspicious/noConfusingVoidType: void preserves existing callback compatibility.
  send: (env: Envelope) => boolean | void;
  sendBounded?: (env: Envelope) => boolean;
  sendLegacyBulk?: (env: Envelope) => boolean;
  log: Logger;
  now?: () => number;
}

const MAX_FAILURES = 20;
const ACK_CACHE = 256;
const HELLO_TIMEOUT_MS = 10_000;

export class PhoneLink {
  readonly phoneFp: string;
  readonly connId: string;
  readonly name: string;
  readonly openedAt: number;
  handshaken = false;
  broken = false;
  /** Set by the agent when no conn.hello arrived within 10 s; cleared by a late conn.hello. */
  dormant = false;
  viewed: string | null = null;
  /**
   * Called once when the link transitions to broken (20 consecutive decrypt failures).
   * Fires synchronously inside handleEnvelope; the handler must not call back into this
   * PhoneLink (e.g. via handleEnvelope or send) — doing so would re-enter that call.
   */
  onBroken?: () => void;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private nPhone: Uint8Array | null = null;
  private seqOut = 0;
  private seqIn = 0;
  private failures = 0;
  private generation = 0;
  private mode: "legacy" | "bounded" = "legacy";
  private readonly acks = new Map<string, InnerMessageOf<"ack">>();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: PhoneLinkOptions) {
    this.phoneFp = opts.phoneFp;
    this.connId = opts.connId;
    this.name = opts.name;
    this.now = opts.now ?? (() => Date.now());
    this.openedAt = this.now();
    this.log = opts.log.child({ phone: opts.phoneFp.slice(0, 8), conn: opts.connId.slice(0, 6) });
  }

  /** True once the 10 s conn.hello window has passed with no handshake. */
  helloOverdue(now: number = this.now()): boolean {
    return !this.handshaken && !this.dormant && now - this.openedAt >= HELLO_TIMEOUT_MS;
  }

  /** Local ownership epoch; never transmitted or used as encryption material. */
  get handshakeGeneration(): number {
    return this.generation;
  }

  get streamMode(): "legacy" | "bounded" {
    return this.mode;
  }

  handleEnvelope(env: Envelope): InnerMessage | null {
    if (this.broken) return null;
    if (this.opts.minProtocolVersion === 2) return null;
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return this.fail("bad body");
    // conn.hello is always accepted under K_pair with seq 0 (re-handshake resets the connection)
    if (env.seq === 0) {
      try {
        const inner = parseInner(
          decodeCbor(open(this.opts.kPair, body.data, helloAd(this.phoneFp, this.opts.computerFp))),
        );
        if (inner.type !== "conn.hello") return this.fail("expected conn.hello");
        // A hello carrying the same phone nonce as the current connection is a replay of a
        // captured conn.hello (the relay has no way to forge a new one under K_pair): ignore it
        // rather than tearing down and re-keying a live connection.
        if (this.nPhone && bytesEqual(inner.n, this.nPhone)) {
          this.log.debug("duplicate conn.hello ignored");
          return null;
        }
        const nAgent = randomBytes(16);
        const d = deriveConnKey(
          this.opts.kPair,
          inner.n,
          nAgent,
          this.opts.computerFp,
          this.phoneFp,
        );
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.nPhone = inner.n;
        this.seqOut = 0;
        this.seqIn = 0;
        this.handshaken = true;
        this.dormant = false;
        this.failures = 0;
        this.viewed = null;
        this.acks.clear();
        this.generation += 1;
        this.mode =
          this.opts.boundedStream && inner.features?.includes(BOUNDED_STREAM_FEATURE)
            ? "bounded"
            : "legacy";
        const reply = seal(
          this.opts.kPair,
          encodeCbor({
            type: "conn.hello",
            n: nAgent,
            ...(this.opts.boundedStream && { features: [BOUNDED_STREAM_FEATURE] }),
          }),
          helloAd(this.opts.computerFp, this.phoneFp),
        );
        this.opts.send({
          v: 1,
          t: "e2e",
          from: this.opts.computerFp,
          to: this.phoneFp,
          seq: 0,
          body: reply,
        });
        this.log.info("handshake complete");
        return null;
      } catch {
        return this.fail("hello decrypt failed");
      }
    }
    if (!this.kConn) return this.fail("frame before handshake");
    if (env.seq <= this.seqIn) {
      this.log.warn("replayed or reordered frame dropped", { seq: env.seq, last: this.seqIn });
      return null;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = open(
        this.kConn,
        body.data,
        frameAd(this.phoneFp, this.opts.computerFp, this.connTag, env.seq),
      );
    } catch {
      return this.fail("frame decrypt failed");
    }
    // The frame is authentic (AEAD verified): advance seq and reset the failure counter
    // regardless of whether its contents parse. Only decrypt failures count toward `broken`
    // — an unrecognised-but-authentic inner message must not.
    this.seqIn = env.seq;
    this.failures = 0;
    let inner: InnerMessage;
    try {
      inner = parseInner(decodeCbor(plaintext));
    } catch (err) {
      this.log.warn("inner message rejected", {
        reason: err instanceof ProtocolError ? err.code : safeErrorName(err),
      });
      return null;
    }
    if ("reqId" in inner) {
      const cached = this.acks.get(inner.reqId);
      if (cached) {
        if (!this.send(cached)) this.log.debug("could not resend cached ack: link not sendable");
        return null;
      }
    }
    return inner;
  }

  send(msg: InnerMessage): boolean {
    const env = this.sealEnvelope(msg);
    return env ? this.opts.send(env) !== false : false;
  }

  sendBounded(msg: InnerMessage): boolean {
    if (!this.opts.sendBounded) return false;
    const env = this.sealEnvelope(msg);
    if (!env || encodeEnvelope(env).byteLength > STREAM_LIMITS.envelopeBytes) return false;
    const admitted: unknown = this.opts.sendBounded(env);
    if (admitted === true) return true;
    if (admitted !== null && (typeof admitted === "object" || typeof admitted === "function")) {
      void new Promise((resolve) => resolve(admitted)).catch(() => {});
    }
    return false;
  }

  sendLegacyBulk(msg: InnerMessageOf<"screen.snapshot" | "screen.diff" | "history">): boolean {
    if (
      !this.opts.sendLegacyBulk ||
      (msg.type !== "screen.snapshot" && msg.type !== "screen.diff" && msg.type !== "history")
    )
      return false;
    const env = this.sealEnvelope(msg);
    if (!env || encodeEnvelope(env).byteLength > FRAME_LIMITS.e2eFromAgent) return false;
    const admitted: unknown = this.opts.sendLegacyBulk(env);
    if (admitted === true) return true;
    if (admitted === false) return false;
    // A callback may have sent already. Unknown outcomes cannot refund admission safely.
    if (admitted !== null && (typeof admitted === "object" || typeof admitted === "function")) {
      void new Promise((resolve) => resolve(admitted)).catch(() => {});
    }
    throw new TypeError("legacy bulk transport must return a synchronous boolean");
  }

  private sealEnvelope(msg: InnerMessage): Envelope | null {
    if (!this.kConn || this.broken) return null;
    this.seqOut += 1;
    const box = seal(
      this.kConn,
      encodeCbor(msg),
      frameAd(this.opts.computerFp, this.phoneFp, this.connTag, this.seqOut),
    );
    return {
      v: 1,
      t: "e2e",
      from: this.opts.computerFp,
      to: this.phoneFp,
      seq: this.seqOut,
      body: box,
    };
  }

  rememberAck(reqId: string, ack: InnerMessageOf<"ack">): void {
    this.acks.set(reqId, ack);
    if (this.acks.size > ACK_CACHE) {
      const first = this.acks.keys().next().value;
      if (first !== undefined) this.acks.delete(first);
    }
  }

  private fail(reason: string): null {
    this.failures += 1;
    this.log.warn(reason, { failures: this.failures });
    if (this.failures >= MAX_FAILURES && !this.broken) {
      this.broken = true;
      this.onBroken?.();
    }
    return null;
  }
}
