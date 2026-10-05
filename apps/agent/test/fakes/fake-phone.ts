import {
  decodeCbor,
  deriveConnKey,
  E2EBodySchema,
  type Envelope,
  encodeCbor,
  fingerprint,
  frameAd,
  helloAd,
  type Identity,
  type InnerMessage,
  open,
  parseInner,
  randomBytes,
  seal,
} from "@shellbell/protocol";

export class FakePhone {
  readonly fp: string;
  private nPhone!: Uint8Array;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seq = 0;
  private lastSeq = 0;

  constructor(
    readonly identity: Identity,
    private readonly computerFp: string,
    private readonly kPair: Uint8Array,
  ) {
    this.fp = fingerprint(identity.ed25519.pub);
  }

  get handshaken(): boolean {
    return this.kConn !== null;
  }

  hello(features?: string[]): Envelope {
    this.nPhone = randomBytes(16);
    this.kConn = null;
    this.seq = 0;
    this.lastSeq = 0;
    const box = seal(
      this.kPair,
      encodeCbor({ type: "conn.hello", n: this.nPhone, ...(features && { features }) }),
      helloAd(this.fp, this.computerFp),
    );
    return { v: 1, t: "e2e", from: this.fp, to: this.computerFp, seq: 0, body: box };
  }

  acceptHello(env: Envelope): void {
    const body = E2EBodySchema.parse(env.body);
    const inner = parseInner(decodeCbor(open(this.kPair, body, helloAd(this.computerFp, this.fp))));
    if (inner.type !== "conn.hello") throw new Error("expected conn.hello");
    const d = deriveConnKey(this.kPair, this.nPhone, inner.n, this.computerFp, this.fp);
    this.kConn = d.kConn;
    this.connTag = d.connTag;
  }

  seal(msg: InnerMessage): Envelope {
    if (!this.kConn) throw new Error("no kConn");
    this.seq += 1;
    const box = seal(
      this.kConn,
      encodeCbor(msg),
      frameAd(this.fp, this.computerFp, this.connTag, this.seq),
    );
    return { v: 1, t: "e2e", from: this.fp, to: this.computerFp, seq: this.seq, body: box };
  }

  open(env: Envelope): InnerMessage {
    if (!this.kConn) throw new Error("no kConn");
    if (env.seq <= this.lastSeq) throw new Error("replay");
    this.lastSeq = env.seq;
    const body = E2EBodySchema.parse(env.body);
    return parseInner(
      decodeCbor(open(this.kConn, body, frameAd(this.computerFp, this.fp, this.connTag, env.seq))),
    );
  }
}
