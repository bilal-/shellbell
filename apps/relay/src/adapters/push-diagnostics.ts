import type { NotificationProvider, SendOutcome } from "@shellbell/relay-core";

export interface PushDeliveryDiagnostic {
  provider: "apns" | "fcm";
  environment?: "development" | "production";
  status: SendOutcome["status"] | "invalid-response";
  code?: Extract<SendOutcome, { code: string }>["code"];
}

const codes = {
  rejected: new Set([
    "invalid-credentials",
    "invalid-device-token",
    "invalid-payload",
    "http-permanent",
  ]),
  retryable: new Set([
    "network",
    "timeout",
    "invalid-response",
    "response-too-large",
    "http-rate-limit",
    "http-server",
  ]),
};

/** Logs only controlled provider categories; never pass an intent or raw response to the reporter. */
export function observePushDelivery(
  provider: NotificationProvider,
  report: (diagnostic: PushDeliveryDiagnostic) => void,
): NotificationProvider {
  return {
    async send(intents) {
      const outcomes = await provider.send(intents);
      for (const [index, intent] of intents.entries()) {
        const destination = intent.destination;
        if (destination.provider !== "apns" && destination.provider !== "fcm") continue;
        const diagnostic: PushDeliveryDiagnostic = {
          provider: destination.provider,
          status: "invalid-response",
        };
        if (
          destination.provider === "apns" &&
          (destination.environment === "development" || destination.environment === "production")
        ) {
          diagnostic.environment = destination.environment;
        }
        const outcome = outcomes[index];
        if (outcome?.status === "accepted" || outcome?.status === "unregistered") {
          diagnostic.status = outcome.status;
        } else if (outcome?.status === "rejected" || outcome?.status === "retryable") {
          diagnostic.status = outcome.status;
          if (codes[outcome.status].has(outcome.code)) diagnostic.code = outcome.code;
        }
        try {
          report(diagnostic);
        } catch {
          // Logging must not turn an accepted push into a retry or delay durable completion.
        }
      }
      return outcomes;
    },
  };
}
