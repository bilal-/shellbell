import {
  bytesEqual,
  decodeEnvelope,
  encodeEnvelope,
  parseCtrl,
  relayWsUrl,
} from "@shellbell/protocol";
import type { PendingRevocation, RevocationOutbox } from "../identity/revocation-outbox";

type ReceiptStatus = "stored" | "absent" | "stale" | "unavailable";
export interface RevocationSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type RevocationSocketFactory = (url: string) => RevocationSocket;

/** Unauthenticated proof-only route; the relay checks signature AND its current pair ID. */
export function submitRevocationProof(
  entry: PendingRevocation,
  createSocket: RevocationSocketFactory,
): Promise<ReceiptStatus | null> {
  return new Promise((resolve) => {
    let socket: RevocationSocket;
    try {
      socket = createSocket(relayWsUrl(entry.relayUrl, entry.proof.computerFp));
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => finish(null), 10_000);
    function finish(status: ReceiptStatus | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState < 2) socket.close();
      resolve(status);
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {};
    socket.onclose = () => finish(null);
    socket.onerror = () => finish(null);
    socket.onmessage = (event) => {
      if (typeof event.data === "string") return;
      let message: ReturnType<typeof parseCtrl>;
      try {
        const data = event.data;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const envelope = decodeEnvelope(bytes);
        if (envelope.t !== "ctrl" || envelope.from !== "relay") return;
        message = parseCtrl(envelope.body);
      } catch {
        return;
      }
      if (message.type === "challenge" && !sent) {
        sent = true;
        try {
          socket.send(
            encodeEnvelope({
              v: 1,
              t: "ctrl",
              from: entry.proof.phoneFp,
              seq: 0,
              body: {
                type: "revocation-submit",
                phoneEd25519Pub: entry.phoneEd25519Pub,
                proof: entry.proof,
              },
            }),
          );
        } catch {
          finish(null);
        }
      } else if (
        sent &&
        message.type === "revocation-receipt" &&
        message.phoneFp === entry.proof.phoneFp &&
        bytesEqual(message.pairId, entry.proof.pairId)
      ) {
        finish(message.status);
      }
    };
  });
}

/** The outbox survives app restarts; failure leaves the proof for a later foreground retry. */
export async function drainRevocationOutbox(
  outbox: RevocationOutbox,
  createSocket: RevocationSocketFactory,
): Promise<void> {
  for (const entry of outbox.list()) {
    const status = await submitRevocationProof(entry, createSocket);
    if (status !== null && status !== "unavailable") {
      // "stale" means a different current pair ID; "absent" means no relay pairing remains.
      // Neither response is evidence that the service's local key was deleted.
      outbox.remove(entry.proof.phoneFp, entry.proof.computerFp, entry.proof.pairId);
    }
  }
}

/** Coalesce concurrent triggers without overlooking a proof inserted mid-drain. */
export function createRevocationRetry(drain: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued = false;
  return () => {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        queued = false;
        await drain();
      } while (queued);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
