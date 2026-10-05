import {
  createV2Handshake,
  decodeV2Frame,
  encodeV2Frame,
  type V2Handshake,
  type V2PairKeys,
  type V2Role,
  type V2SecureSession,
  type V2SessionContext,
} from "./session-v2.js";
import { decodeV2Bootstrap, encodeV2Bootstrap } from "./session-v2-signaling.js";

/** The same reviewed empty-payload Noise exchange, carried on the verified data channel. */
export class V2DirectHandshake {
  private handshake: V2Handshake | null;
  private session: V2SecureSession | null = null;
  private phase: "new" | "noise1" | "noise2" | "confirm" | "ready" | "closed";
  constructor(
    private readonly context: V2SessionContext,
    private readonly role: V2Role,
    keys: V2PairKeys,
    private readonly actualRemoteCertificate: Uint8Array,
  ) {
    if (context.route !== "direct") throw new Error("direct context required");
    this.handshake = createV2Handshake(context, role, keys);
    this.phase = role === "phone" ? "new" : "noise1";
  }
  get ready(): boolean {
    return this.phase === "ready" && this.session?.ready === true;
  }
  begin(): Uint8Array {
    if (this.phase !== "new" || !this.handshake) throw new Error("direct handshake order");
    this.phase = "noise2";
    return encodeV2Bootstrap({
      type: "session.v2.noise1",
      sessionId: this.context.sessionId,
      attemptId: this.context.attemptId,
      message: this.handshake.write(),
    });
  }
  receive(bytes: Uint8Array): Uint8Array | null {
    try {
      if ((this.phase === "noise1" || this.phase === "noise2") && this.handshake) {
        const expectedType = this.phase === "noise1" ? "session.v2.noise1" : "session.v2.noise2";
        const message = decodeV2Bootstrap(bytes, {
          sender: this.role === "phone" ? "computer" : "phone",
          expectedType,
          sessionId: this.context.sessionId,
          attemptId: this.context.attemptId,
        });
        if (message.type !== expectedType) throw new Error("direct handshake order");
        this.handshake.read(message.message);
        let answer: Uint8Array | null = null;
        if (this.role === "computer")
          answer = encodeV2Bootstrap({
            type: "session.v2.noise2",
            sessionId: this.context.sessionId,
            attemptId: this.context.attemptId,
            message: this.handshake.write(),
          });
        this.session = this.handshake.finish();
        this.handshake = null;
        this.session.verifyRemoteDtls(this.actualRemoteCertificate);
        this.phase = "confirm";
        return (
          answer ??
          encodeV2Bootstrap({
            type: "session.v2.confirm",
            sessionId: this.context.sessionId,
            attemptId: this.context.attemptId,
            frame: encodeV2Frame(this.session.confirmation()),
          })
        );
      }
      if (this.phase !== "confirm" || !this.session) throw new Error("direct handshake order");
      const message = decodeV2Bootstrap(bytes, {
        sender: this.role === "phone" ? "computer" : "phone",
        expectedType: "session.v2.confirm",
        sessionId: this.context.sessionId,
        attemptId: this.context.attemptId,
      });
      if (message.type !== "session.v2.confirm") throw new Error("direct confirmation required");
      this.session.acceptConfirmation(decodeV2Frame(message.frame));
      const answer =
        this.role === "computer"
          ? encodeV2Bootstrap({
              type: "session.v2.confirm",
              sessionId: this.context.sessionId,
              attemptId: this.context.attemptId,
              frame: encodeV2Frame(this.session.confirmation()),
            })
          : null;
      if (!this.session.ready) throw new Error("direct confirmation incomplete");
      this.phase = "ready";
      return answer;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  takeReadySession(): V2SecureSession {
    if (!this.ready || !this.session) throw new Error("direct handshake incomplete");
    const result = this.session;
    this.session = null;
    this.phase = "closed";
    return result;
  }
  close(): void {
    this.handshake?.close();
    this.handshake = null;
    this.session?.close();
    this.session = null;
    this.phase = "closed";
  }
}
