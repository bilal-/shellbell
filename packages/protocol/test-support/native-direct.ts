import type { NativeDirectEvents, NativeDirectFactory } from "../src/session-v2-endpoint.js";

/** Two independent reliable native pipes, deliberately faster than test relay. */
export function fakeNativeDirectPair() {
  const callbacks: Partial<Record<"phone" | "computer", NativeDirectEvents>> = {};
  const factory =
    (role: "phone" | "computer"): NativeDirectFactory =>
    async (events) => {
      callbacks[role] = events;
      const other = role === "phone" ? "computer" : "phone";
      const digest = new Uint8Array(32).fill(role === "phone" ? 13 : 17);
      const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
      const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:abc\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
      let closed = false;
      return {
        async offer() {
          events.description(sdp, "offer");
        },
        async answer() {
          events.description(sdp, "answer");
        },
        async acceptAnswer() {
          queueMicrotask(() => {
            callbacks.computer!.open();
            callbacks.phone!.open();
          });
        },
        async candidate() {},
        async remoteCertificate() {
          return new Uint8Array(32).fill(role === "phone" ? 17 : 13);
        },
        send(bytes) {
          if (closed) return false;
          const copy = bytes.slice();
          queueMicrotask(() => callbacks[other]?.message(copy));
          return true;
        },
        close() {
          if (closed) return;
          closed = true;
          const peer = callbacks[other];
          queueMicrotask(() => peer?.closed());
        },
      };
    };
  return { phone: factory("phone"), computer: factory("computer") };
}
