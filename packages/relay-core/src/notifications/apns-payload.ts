import { pushEnvelope, pushPayloadFits } from "./message.js";
import type { PushIntent } from "./models.js";

export interface ApnsPayload {
  headers: {
    "apns-push-type": "alert";
    "apns-priority": "10";
    "apns-expiration": string;
    "apns-collapse-id": string;
  };
  body: {
    aps: {
      alert: { title: string; body: string };
      sound: "default";
      category: "ring";
      "thread-id": string;
      "mutable-content"?: 1;
    };
    body: Record<string, unknown>;
  };
}

export function buildApnsPayload(intent: PushIntent): ApnsPayload {
  if (intent.destination.provider !== "apns") throw new Error("APNs destination required");
  const make = (rich: boolean): ApnsPayload => ({
    headers: {
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(intent.expiresAtSeconds),
      "apns-collapse-id": intent.group,
    },
    body: {
      aps: {
        alert: { title: intent.genericTitle, body: intent.genericBody },
        sound: "default",
        category: "ring",
        "thread-id": intent.group,
        ...(rich ? { "mutable-content": 1 as const } : {}),
      },
      body: pushEnvelope(intent, rich),
    },
  });
  if (intent.box) {
    const rich = make(true);
    if (pushPayloadFits(rich.body)) return rich;
  }
  const generic = make(false);
  if (!pushPayloadFits(generic.body)) throw new Error("APNs payload exceeds limit");
  return generic;
}
