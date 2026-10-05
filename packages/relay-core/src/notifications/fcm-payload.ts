import { pushEnvelope, pushPayloadFits } from "./message.js";
import type { PushIntent } from "./models.js";

export interface FcmPayload {
  message: {
    token: string;
    data: { body: string };
    notification?: { title: string; body: string };
    android: {
      priority: "HIGH";
      collapse_key: string;
      ttl: string;
      notification?: { channel_id: "rings"; sound: "default"; tag: string };
    };
  };
}

export function buildFcmPayload(intent: PushIntent, nowMs = Date.now()): FcmPayload {
  if (intent.destination.provider !== "fcm") throw new Error("FCM destination required");
  const make = (rich: boolean): FcmPayload => ({
    message: {
      token: intent.destination.token,
      data: { body: JSON.stringify(pushEnvelope(intent, rich)) },
      ...(!rich ? { notification: { title: intent.genericTitle, body: intent.genericBody } } : {}),
      android: {
        priority: "HIGH",
        collapse_key: intent.group,
        ttl: `${Math.max(0, Math.min(2419200, intent.expiresAtSeconds - Math.floor(nowMs / 1000)))}s`,
        ...(!rich
          ? { notification: { channel_id: "rings", sound: "default", tag: intent.group } }
          : {}),
      },
    },
  });
  // The registration token routes the request; it is not notification payload data.
  const fits = (payload: FcmPayload): boolean => {
    const { token: _token, ...message } = payload.message;
    return pushPayloadFits(message);
  };
  if (intent.box) {
    const rich = make(true);
    if (fits(rich)) return rich;
  }
  const generic = make(false);
  if (!fits(generic)) throw new Error("FCM payload exceeds limit");
  return generic;
}
