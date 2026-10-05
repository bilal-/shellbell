import {
  deriveNotificationKey,
  type InnerMessage,
  NOTIFICATION_FEATURE,
  randomBytes,
  toBase64Url,
} from "@shellbell/protocol";
import type { NativeNotifications } from "./native";

export interface NotificationEnrollmentLink {
  current(): boolean;
  send(message: InnerMessage): boolean;
}
interface Attempt {
  link: NotificationEnrollmentLink;
  generation: string;
  sent: boolean;
  acknowledged: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** One authenticated connection generation. Never persists a pair key or a JS generation cache. */
export class NotificationEnrollment {
  private attempt: Attempt | null = null;
  constructor(
    private readonly options: {
      computerFp: string;
      phoneFp: string;
      kPair: Uint8Array;
      native?: Pick<NativeNotifications, "notificationReadiness" | "installNotificationKey">;
    },
  ) {}

  get ready(): boolean {
    return this.attempt?.acknowledged === true && this.attempt.link.current();
  }

  cancel(): void {
    if (this.attempt?.timer) clearTimeout(this.attempt.timer);
    this.attempt = null;
  }

  async begin(link: NotificationEnrollmentLink, features: readonly string[]): Promise<void> {
    this.cancel();
    const native = this.options.native;
    if (!native || !features.includes(NOTIFICATION_FEATURE) || !link.current()) return;
    const attempt: Attempt = {
      link,
      generation: toBase64Url(randomBytes(16)),
      sent: false,
      acknowledged: false,
    };
    this.attempt = attempt;
    const current = () => this.attempt === attempt && link.current();
    let derived: Uint8Array | undefined;
    try {
      const readiness = await native.notificationReadiness();
      if (!current()) return;
      if (!readiness.crypto || !readiness.storage || !readiness.receiver) {
        this.cancel();
        return;
      }
      derived = deriveNotificationKey(this.options.kPair, {
        computerFp: this.options.computerFp,
        phoneFp: this.options.phoneFp,
        generation: attempt.generation,
      });
      await native.installNotificationKey(
        this.options.computerFp,
        this.options.phoneFp,
        attempt.generation,
        toBase64Url(derived),
      );
      if (!current()) return;
      attempt.sent = true;
      attempt.timer = setTimeout(() => {
        if (this.attempt === attempt) this.cancel();
      }, 10000);
      if (!link.send({ type: "notification.enroll", generation: attempt.generation }))
        this.cancel();
    } catch {
      if (this.attempt === attempt) this.cancel();
    } finally {
      derived?.fill(0);
    }
  }

  acknowledge(generation: string): boolean {
    const attempt = this.attempt;
    if (
      !attempt?.sent ||
      attempt.acknowledged ||
      !attempt.link.current() ||
      attempt.generation !== generation
    )
      return false;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
    attempt.acknowledged = true;
    return true;
  }
}
