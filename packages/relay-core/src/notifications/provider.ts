import { type ApnsCredentials, sendApns } from "./apns.js";
import { type FcmCredentials, sendFcm } from "./fcm.js";
import type { PushIntent } from "./models.js";
import { decodePrivateKeyPem } from "./private-key.js";

/** Direct-provider acknowledgement, not a device-delivery receipt. */
export type SendOutcome =
  | { status: "accepted" }
  | { status: "unregistered" }
  | {
      status: "rejected";
      code: "invalid-credentials" | "invalid-device-token" | "invalid-payload" | "http-permanent";
    }
  | {
      status: "retryable";
      code:
        | "network"
        | "timeout"
        | "invalid-response"
        | "response-too-large"
        | "http-rate-limit"
        | "http-server";
      retryAfterMs?: number;
    };

export interface NotificationProvider {
  send(intents: readonly PushIntent[]): Promise<readonly SendOutcome[]>;
}

export interface DirectPushCredentials {
  fcm?: FcmCredentials;
  apns?: ApnsCredentials;
}
export interface DirectPushPrivateConfig {
  fcmServiceAccountJson?: string;
  apnsPrivateKey?: string;
  apnsTeamId?: string;
  apnsKeyId?: string;
  apnsTopic?: string;
}
export type PushConfigurationReporter = (
  provider: "fcm" | "apns",
  code: "missing-credentials" | "invalid-credentials",
) => void;

/** Linear checks only: malformed optional secrets must not block relay startup. */
function validPrivateKey(value: unknown): value is string {
  try {
    decodePrivateKeyPem(value);
    return true;
  } catch {
    return false;
  }
}

/** Parses only private operator configuration; diagnostics never include input values. */
export function parseDirectPushCredentials(
  config: DirectPushPrivateConfig,
  report: PushConfigurationReporter = () => {},
): DirectPushCredentials {
  const credentials: DirectPushCredentials = {};
  if (!config.fcmServiceAccountJson) report("fcm", "missing-credentials");
  else {
    try {
      if (config.fcmServiceAccountJson.length > 65536) throw new Error();
      const value: unknown = JSON.parse(config.fcmServiceAccountJson);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const data = value as Record<string, unknown>;
      if (
        data.type !== "service_account" ||
        typeof data.project_id !== "string" ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(data.project_id) ||
        typeof data.client_email !== "string" ||
        data.client_email.length > 320 ||
        !/^[^\s@]+@[^\s@]+$/.test(data.client_email) ||
        !validPrivateKey(data.private_key)
      )
        throw new Error();
      credentials.fcm = {
        projectId: data.project_id,
        clientEmail: data.client_email,
        privateKey: data.private_key,
      };
    } catch {
      report("fcm", "invalid-credentials");
    }
  }
  const apnsValues = [config.apnsPrivateKey, config.apnsTeamId, config.apnsKeyId, config.apnsTopic];
  if (apnsValues.every((value) => !value)) report("apns", "missing-credentials");
  else if (
    !validPrivateKey(config.apnsPrivateKey) ||
    !/^[A-Z0-9]{10}$/.test(config.apnsTeamId ?? "") ||
    !/^[A-Z0-9]{10}$/.test(config.apnsKeyId ?? "") ||
    !config.apnsTopic ||
    config.apnsTopic.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.apnsTopic)
  )
    report("apns", "invalid-credentials");
  else
    credentials.apns = {
      privateKey: config.apnsPrivateKey,
      teamId: config.apnsTeamId!,
      keyId: config.apnsKeyId!,
      topic: config.apnsTopic,
    };
  return credentials;
}

/** Separate transports let Node use HTTP/2 for APNs and fetch for FCM. */
export function createDirectNotificationProvider(
  options: DirectPushCredentials & {
    fcmFetch?: typeof fetch;
    apnsFetch?: typeof fetch;
    now?: () => number;
  } = {},
): NotificationProvider {
  return {
    async send(intents) {
      return Promise.all(
        intents.map((intent): Promise<SendOutcome> | SendOutcome => {
          if (intent.destination.provider === "fcm" && options.fcm)
            return sendFcm(intent, options.fcm, options.fcmFetch, options.now);
          if (intent.destination.provider === "apns" && options.apns)
            return sendApns(intent, options.apns, options.apnsFetch, options.now);
          return { status: "rejected", code: "invalid-credentials" };
        }),
      );
    },
  };
}

/** Default until runtime credentials are configured; terminal relay remains available. */
export const unavailableNotificationProvider: NotificationProvider = {
  async send(intents) {
    return intents.map(() => ({ status: "rejected", code: "invalid-credentials" }));
  },
};
