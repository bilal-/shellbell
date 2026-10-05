import {
  buildRingNotification,
  type RingNotification,
  type RingPayload,
  type SessionLabel,
} from "./content";

/**
 * Pure decision logic for replacing the relay's generic ring notification with one that names its
 * session (spec 2026-09-20 §4). No Expo or react-native import here on purpose, so this file can
 * be imported by node tests. The real, Expo-backed deps (and the background task that wires them
 * up) live in `./index.ts`, which node tests never import.
 */
export interface RingHandlerDeps {
  allowDetails?: () => Promise<boolean>;
  lookup: (fp: string, sessionId: string) => SessionLabel | undefined;
  present: (n: RingNotification) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
}

/**
 * Spec 2026-09-20 §4: the relay always sends a real notification so delivery is never at risk;
 * when this task gets to run we replace it with one that names the session. Keyed
 * `${fp}:${sessionId}`, so a session's next ring overwrites its previous notification instead of
 * stacking. If this never runs, the generic notification simply stands — no regression.
 *
 * `incomingIdentifier` is `undefined` when the generic notification's own identifier could not be
 * determined (review I3: on the plain-message path, Android may fall back to a random UUID that
 * we cannot reconstruct in JS — see `selectRingInput` below). In that case we still present the
 * enriched notification, but skip the dismiss: calling `dismiss("")` would be a no-op at best and
 * risks dismissing an unrelated notification at worst.
 */
export async function handleIncomingRing(
  payload: RingPayload,
  incomingIdentifier: string | undefined,
  deps: RingHandlerDeps,
): Promise<void> {
  // Rich payloads have one native pre-display owner on both platforms.
  if (payload.shellbellNotification === "notify-context-v1") return;
  if (!payload.computerFp || !payload.sessionId || !payload.kind) return;
  try {
    if (deps.allowDetails && !(await deps.allowDetails())) return;
  } catch {
    return;
  }
  const n = buildRingNotification(payload, deps.lookup);
  await deps.present(n);
  if (incomingIdentifier) await deps.dismiss(incomingIdentifier);
}

/**
 * Spec §6 / review C2: schedules on the same `rings` Android channel the generic notification
 * used (created in `index.ts`'s `ensureChannel`). Verified against the installed
 * `expo-notifications/src/Notifications.types.ts`: `NotificationContentInput` has no `channelId`
 * field — only `ChannelAwareTriggerInput` (`{ channelId: string }`, one arm of the
 * `NotificationTriggerInput` union) does. The pre-fix code passed `trigger: null`, which Android's
 * `BaseNotificationBuilder.kt` resolves by falling back to
 * `expo_notifications_fallback_notification_channel` — losing the `rings` channel's emerald
 * light/vibration pattern, silently creating a second channel, and breaking mute for anyone who
 * mutes `rings`. `content.data` carries the payload through so a tap still routes (review C1).
 */
const RING_CHANNEL_ID = "rings";

export interface RingScheduleInput {
  identifier: string;
  content: { title: string; body: string; sound: "default"; data: RingPayload };
  trigger: { channelId: string };
}

export function buildScheduleInput(n: RingNotification): RingScheduleInput {
  return {
    identifier: n.identifier,
    content: { title: n.title, body: n.body, sound: "default", data: n.data },
    trigger: { channelId: RING_CHANNEL_ID },
  };
}

/**
 * A "content"-shaped object as `expo-task-manager`'s background task actually delivers it.
 * Verified against the installed native source (not the SDK's own JS mapping, which never runs
 * on this path): `RemoteMessageSerializer.java` builds `{ data: { dataString, ...rawFcmFields },
 * notification, ... }` for a plain incoming push, and `NotificationSerializer.java` builds
 * `{ ..., content: { dataString, ... } }` for a background action-tap response — in both cases
 * `dataString` is the relay's `data` object (`{computerFp, sessionId, kind}`), JSON-encoded by
 * Expo's push service. `mapNotificationResponse.ts`'s `mapNotificationContent` performs this same
 * `dataString` → `JSON.parse` → `.data` mapping for the *other* paths (the emitter, the handler,
 * `getPresentedNotificationsAsync`) — confirming the shape — but is never wired into the
 * `expo-task-manager` background path, which is why reading `.data` alone (as opposed to
 * `.dataString`) leaves the background task permanently inert. `.data` is still checked, as a
 * fallback, in case a future SDK version (or a differently-shaped platform payload) maps it.
 */
export interface RawRingContent {
  data?: unknown;
  dataString?: unknown;
  /**
   * Only present on the plain-message shape (`RemoteMessageSerializer.java` flattens the FCM
   * `data` map's entries alongside `dataString`). Review I2: this is the dismissal identifier
   * Android actually posted the generic notification under — see `selectRingInput` below.
   */
  tag?: unknown;
}

function isRingPayload(v: unknown): v is RingPayload {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.computerFp === "string" &&
    r.shellbellNotification !== "notify-context-v1" &&
    typeof r.sessionId === "string" &&
    typeof r.kind === "string"
  );
}

/**
 * Pure, fail-safe extraction: malformed JSON or a payload missing a required field yields
 * `undefined`, never a throw — a throw inside a background task is worse than the generic
 * notification standing (spec §4's designed fallback).
 */
export function extractRingPayload(
  content: RawRingContent | null | undefined,
): RingPayload | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content.dataString === "string") {
    try {
      const parsed: unknown = JSON.parse(content.dataString);
      return isRingPayload(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRingPayload(content.data) ? content.data : undefined;
}

/**
 * The raw shape `expo-task-manager` hands the background task, per the installed native source
 * (see `RawRingContent`'s doc comment above): either a `NotificationResponse` (a background
 * action tap — has `actionIdentifier`, and its content lives at `notification.request.content`),
 * or a plain incoming remote message (no `actionIdentifier`; its content is `data` itself, and
 * `notification` is the raw, unrelated FCM/APNs notification fields — never `.request`). Kept
 * distinct from `RawRingContent` deliberately: they describe different levels of the payload.
 */
export interface RawRingTaskData {
  actionIdentifier?: unknown;
  notification?: { request?: { identifier?: unknown; content?: RawRingContent } } | null;
  data?: RawRingContent;
  messageId?: unknown;
}

export interface RingInput {
  content: RawRingContent | undefined;
  identifier: string | undefined;
}

/**
 * Pure shape selection (review I1), previously inline and untested in `index.ts`'s `defineTask`.
 *
 * Response shape: content and identifier both come from `notification.request` (`
 * NotificationSerializer.java`).
 *
 * Plain-message shape: content is `data` itself. The identifier mirrors Android's own rule for
 * what it posted the generic notification under — verified against the installed
 * `FirebaseMessagingDelegate.kt`'s `getNotificationIdentifier`:
 * `remoteMessage.data["tag"] ?: remoteMessage.messageId ?: UUID.randomUUID().toString()` (review
 * I2). We can't reconstruct the random-UUID fallback in JS, so when neither `tag` nor `messageId`
 * is present the identifier is `undefined` — `handleIncomingRing` then skips the dismiss (I3)
 * rather than dismissing the wrong (or no) notification.
 */
export function selectRingInput(raw: RawRingTaskData | null | undefined): RingInput | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw.actionIdentifier === "string") {
    const rawIdentifier = raw.notification?.request?.identifier;
    return {
      content: raw.notification?.request?.content,
      identifier: typeof rawIdentifier === "string" ? rawIdentifier : undefined,
    };
  }
  const tag = raw.data?.tag;
  const identifier =
    typeof tag === "string" ? tag : typeof raw.messageId === "string" ? raw.messageId : undefined;
  return { content: raw.data, identifier };
}
