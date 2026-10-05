import { NOTIFICATION_LIMITS, NotificationBoxSchema } from "@shellbell/protocol";
import { type ContextRegistration, type PushContextJob, selectPushContext } from "./context.js";
import { pushBody, pushSessionGroup } from "./message.js";
import type { PushIntent } from "./models.js";

export type NativeContextRegistration = ContextRegistration & {
  token: string;
  provider: "fcm" | "apns";
  environment?: "development" | "production";
};

/** Only opaque routing and authenticated ciphertext cross the provider boundary. */
export function buildPushIntent(
  job: PushContextJob,
  registration: NativeContextRegistration,
): PushIntent {
  if (
    !registration.token ||
    !["fcm", "apns"].includes(registration.provider) ||
    (registration.provider === "fcm" &&
      (registration.platform !== "android" || registration.environment !== undefined)) ||
    (registration.provider === "apns" &&
      (registration.platform !== "ios" ||
        !["development", "production"].includes(registration.environment ?? "")))
  )
    throw new Error("Invalid native push destination");
  const parsed = NotificationBoxSchema.safeParse(job.context);
  const box = parsed.success
    ? selectPushContext(
        {
          type: "notify-context",
          sessionId: job.sessionId,
          eventId: parsed.data.eventId,
          kind: job.kind,
          boxes: [parsed.data],
        },
        registration.phoneFp,
        registration,
      )
    : undefined;
  const rich = box?.computerFp === job.computerFp ? box : undefined;
  return {
    destination: {
      provider: registration.provider,
      token: registration.token,
      ...(registration.environment ? { environment: registration.environment } : {}),
    },
    route: { computerFp: job.computerFp, sessionId: job.sessionId, kind: job.kind },
    genericTitle: "Shellbell",
    genericBody: rich
      ? "A terminal session needs attention"
      : pushBody(job.kind, job.exitCode, job.durationMs),
    ...(rich ? { box: rich } : {}),
    group: pushSessionGroup(job.computerFp, job.sessionId),
    expiresAtSeconds: Math.floor(
      (rich
        ? Math.min(job.expiresAt, job.admittedAt + NOTIFICATION_LIMITS.freshnessMs)
        : job.expiresAt) / 1000,
    ),
  };
}
