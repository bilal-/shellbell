import {
  type CtrlMessageOf,
  NOTIFICATION_FEATURE,
  type NotificationBox,
  NotificationBoxSchema,
} from "@shellbell/protocol";
import type { NotifyMessage } from "./models.js";

export interface ContextRegistration {
  computerFp: string;
  phoneFp: string;
  platform: string | null;
  features: readonly string[];
}

export function selectPushContext(
  message: NotifyMessage,
  phoneFp: string,
  registration: ContextRegistration,
): NotificationBox | undefined {
  if (
    message.type !== "notify-context" ||
    phoneFp !== registration.phoneFp ||
    !registration.features.includes(NOTIFICATION_FEATURE) ||
    !["ios", "android"].includes(registration.platform ?? "")
  )
    return undefined;
  const result = NotificationBoxSchema.safeParse(message.boxes.find((b) => b.phoneFp === phoneFp));
  if (
    !result.success ||
    result.data.computerFp !== registration.computerFp ||
    result.data.sessionId !== message.sessionId ||
    result.data.eventId !== message.eventId
  )
    return undefined;
  return result.data;
}
export interface PushContextJob {
  computerFp: string;
  sessionId: string;
  kind: CtrlMessageOf<"notify">["kind"];
  exitCode?: number;
  durationMs?: number;
  admittedAt: number;
  expiresAt: number;
  context?: unknown;
}
