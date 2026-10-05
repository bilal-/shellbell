import Storage from "expo-sqlite/kv-store";
import { RevocationOutbox } from "../identity/revocation-outbox";
import {
  createRevocationRetry,
  drainRevocationOutbox,
  type RevocationSocket,
} from "./revocation-delivery";

const outbox = new RevocationOutbox(Storage);
const retry = createRevocationRetry(() =>
  drainRevocationOutbox(outbox, (url) => new WebSocket(url) as unknown as RevocationSocket),
);

/** Called on launch, foreground, a short active-app interval, and immediately after unpair. */
export function retryPendingRevocations(): Promise<void> {
  return retry();
}

export function durableRevocationOutbox(): RevocationOutbox {
  return outbox;
}
