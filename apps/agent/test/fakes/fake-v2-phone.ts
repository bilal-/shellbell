import {
  decodeCbor,
  type Envelope,
  encodeCbor,
  fingerprint,
  type Identity,
  type InnerMessage,
  type NativeDirectFactory,
  parseInner,
  type RoutableEnvelope,
  V2PairEndpoint,
} from "@shellbell/protocol";

/**
 * A paired phone speaking secure v2 like the app: it negotiates over the relay, then carries
 * terminal messages only on the direct route. `seal` returns a stand-in envelope that the
 * socket hands back to `sendSealed`, so tests can keep building messages before sending them.
 */
export class FakeV2Phone {
  readonly fp: string;
  private endpoint: V2PairEndpoint | null = null;
  private readonly sealed = new WeakMap<object, InnerMessage>();

  constructor(
    readonly identity: Identity,
    private readonly computerFp: string,
    readonly kPair: Uint8Array,
    readonly computerX25519Pub: Uint8Array,
    private readonly native: NativeDirectFactory,
    private readonly sendRelay: (envelope: RoutableEnvelope) => boolean,
    private readonly onInner: (message: InnerMessage) => void,
  ) {
    this.fp = fingerprint(identity.ed25519.pub);
  }

  /** True once the direct route carries terminal messages. */
  get handshaken(): boolean {
    return this.endpoint?.activeRoute === "direct";
  }

  /** Starts a fresh secure session, as the app does when it (re)connects. */
  begin(): void {
    this.endpoint?.close();
    const endpoint = new V2PairEndpoint({
      role: "phone",
      computerFp: this.computerFp,
      phoneFp: this.fp,
      keys: {
        staticPrivate: this.identity.x25519.priv,
        remoteStatic: this.computerX25519Pub,
        pairKey: this.kPair,
      },
      sendRelay: (envelope) => this.sendRelay(envelope),
      commitFloor: async () => {},
      prepareReady: () => true,
      native: this.native,
      allowDirect: true,
      terminal: (bytes) => this.onInner(parseInner(decodeCbor(bytes))),
      routeChanged: (route) => {
        // Like the app: the computer's bootstrap starts with the phone's first direct message.
        if (route === "direct")
          endpoint.sendTerminal(encodeCbor({ type: "subscribe", sessionId: null }));
      },
      failure: () => {},
    });
    this.endpoint = endpoint;
    endpoint.begin();
  }

  receive(envelope: RoutableEnvelope): void {
    void this.endpoint?.receiveRelay(envelope);
  }

  seal(message: InnerMessage): Envelope {
    return this.stand(message);
  }

  /** Sends a `seal`ed message on the direct route; false when it is not available. */
  sendSealed(envelope: Envelope): boolean | undefined {
    const message = this.sealed.get(envelope);
    if (!message) return undefined;
    return this.endpoint?.sendTerminal(encodeCbor(message)) ?? false;
  }

  private stand(message: InnerMessage): Envelope {
    const stand: Envelope = {
      v: 1,
      t: "e2e",
      from: this.fp,
      to: this.computerFp,
      seq: 1,
      body: {},
    };
    this.sealed.set(stand, message);
    return stand;
  }

  close(): void {
    this.endpoint?.close();
    this.endpoint = null;
  }
}
