import type { CtrlMessageOf, NotificationBox } from "@shellbell/protocol";
export type NotifyMessage = CtrlMessageOf<"notify"> | CtrlMessageOf<"notify-context">;
export interface PushIntent {
  destination: {
    provider: "fcm" | "apns";
    token: string;
    environment?: "development" | "production";
  };
  route: { computerFp: string; sessionId: string; kind: "prompt" | "idle" | "blocked" };
  genericTitle: string;
  genericBody: string;
  box?: NotificationBox;
  group: string;
  expiresAtSeconds: number;
}
export type JobState = "pending-send" | "sending" | "pending-receipt" | "checking-receipt";
/** Detached domain snapshots. Updating a returned value never changes durable state. */
export type Job = Readonly<{
  id: string;
  phoneFp: string;
  generation: string;
  state: JobState;
  admittedAt: number;
  expiresAt: number;
  dueAt: number;
  sendCount: number;
  checkCount: number;
  claimId: string | null;
  claimUntil: number | null;
  sessionId: string | null;
  kind: CtrlMessageOf<"notify">["kind"] | null;
  exitCode: number | null;
  durationMs: number | null;
  ticketId: string | null;
  acceptedAt: number | null;
  context: Readonly<NotificationBox> | null;
}>;
export type Registration = Readonly<{
  generation: string;
  token: string | null;
  provider: "fcm" | "apns" | null;
  environment: "development" | "production" | null;
  enabled: boolean;
  platform: string | null;
  features: readonly string[];
}>;
export type Claim = Readonly<{ job: Job; token: string; registration: Registration }>;
