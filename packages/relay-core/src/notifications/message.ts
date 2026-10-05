import {
  type EventKind,
  NOTIFICATION_FEATURE,
  NOTIFICATION_LIMITS,
  sha256,
  toBase64Url,
  utf8,
} from "@shellbell/protocol";
import type { PushIntent } from "./models.js";

export function pushEnvelope(intent: PushIntent, rich: boolean): Record<string, unknown> {
  return {
    ...intent.route,
    ...(rich && intent.box
      ? { shellbellNotification: NOTIFICATION_FEATURE, context: intent.box }
      : {}),
  };
}

/** Payload bound is deliberately stricter than either platform's 4 KiB limit. */
export function pushPayloadFits(payload: unknown): boolean {
  return utf8(JSON.stringify(payload)).length <= Math.min(4096, NOTIFICATION_LIMITS.providerBytes);
}

/** Stable across events/retries; bounded to 47 ASCII bytes for APNs' 64-byte cap. */
export function pushSessionGroup(computerFp: string, sessionId: string): string {
  // Tuple encoding avoids delimiter ambiguity. Hashing adds no private content:
  // both opaque identifiers already appear in the routing payload.
  return `sb1_${toBase64Url(
    sha256(utf8(JSON.stringify(["shellbell-push-session-v1", computerFp, sessionId]))),
  )}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function pushBody(
  kind: EventKind | "prompt" | "idle",
  exitCode?: number,
  durationMs?: number,
): string {
  switch (kind) {
    case "prompt": {
      const exit = exitCode === undefined ? "" : ` — exit ${exitCode}`;
      const dur = durationMs === undefined ? "" : ` after ${formatDuration(durationMs)}`;
      return `A command finished${exit}${dur}`;
    }
    case "idle":
      return "A session went quiet — waiting for you?";
    case "blocked":
      // spec 8.13/11.3: deliberately generic — the relay never learns which agent, which
      // session title, or what it is asking.
      return "An agent is waiting for you";
    default:
      return "A session needs attention";
  }
}
