import type { NativeDirectEvents, NativeDirectFactory } from "@shellbell/protocol";

/**
 * Native pipes for one computer and any number of phones. Each phone's offer names it in its
 * ICE username fragment, so the computer's answering peer connects to the phone that offered.
 */
export function fakeNativeDirectHub() {
  type Peer = { events: NativeDirectEvents; other: Peer | null; closed: boolean };
  const phones = new Map<string, Peer>();
  /** Byte length of each encrypted frame delivered to the computer. */
  const toComputer: number[] = [];
  /** Byte length of each encrypted frame delivered to a phone. */
  const toPhone: number[] = [];
  let next = 0;
  const description = (ufrag: string, digestFill: number) => {
    const fingerprint = Array(32).fill(digestFill.toString(16).padStart(2, "0")).join(":");
    return `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
  };
  const pipe = (self: Peer, certificate: number, sent?: number[]) => ({
    async candidate() {},
    async remoteCertificate() {
      return new Uint8Array(32).fill(certificate);
    },
    send(bytes: Uint8Array) {
      const other = self.other;
      if (self.closed || !other || other.closed) return false;
      const copy = bytes.slice();
      sent?.push(copy.byteLength);
      queueMicrotask(() => {
        if (!other.closed) other.events.message(copy);
      });
      return true;
    },
    close() {
      if (self.closed) return;
      self.closed = true;
      const other = self.other;
      if (other && !other.closed) queueMicrotask(() => other.events.closed());
    },
  });
  const phone: NativeDirectFactory = async (events) => {
    const self: Peer = { events, other: null, closed: false };
    next += 1;
    const ufrag = `phone${next}`;
    phones.set(ufrag, self);
    return {
      ...pipe(self, 17, toComputer),
      async offer() {
        events.description(description(ufrag, 13), "offer");
      },
      async answer() {
        throw new Error("a fake phone only offers");
      },
      async acceptAnswer() {
        queueMicrotask(() => {
          if (self.closed || !self.other || self.other.closed) return;
          self.other.events.open();
          events.open();
        });
      },
    };
  };
  const computer: NativeDirectFactory = async (events) => {
    const self: Peer = { events, other: null, closed: false };
    return {
      ...pipe(self, 13, toPhone),
      async offer() {
        throw new Error("a fake computer only answers");
      },
      async answer(sdp: string) {
        const offerer = phones.get(/a=ice-ufrag:(\S+)/.exec(sdp)?.[1] ?? "");
        if (!offerer) throw new Error("answer for an unknown phone");
        self.other = offerer;
        offerer.other = self;
        events.description(description("computer", 17), "answer");
      },
      async acceptAnswer() {
        throw new Error("a fake computer only answers");
      },
    };
  };
  return { phone, computer, toComputer, toPhone };
}
