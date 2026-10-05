import { closeSync, fsyncSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  FpSchema,
  MAX_PAIRINGS,
  NOTIFICATION_LIMITS,
  NotificationGenerationSchema,
} from "@shellbell/protocol";
import { z } from "zod";
import { ensureDir, type Paths, writeSecretFile } from "./config.js";
import { boundedRead, HostFileError, optionalStat } from "./host-files.js";

const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((s) => BigInt(s) <= 18446744073709551615n);
const generation = z.strictObject({
  generation: NotificationGenerationSchema,
  used: z.number().int().min(0).max(NOTIFICATION_LIMITS.encryptions),
});
const schema = z.strictObject({
  version: z.literal(1),
  phones: z
    .array(
      z.strictObject({
        phoneFp: FpSchema,
        sequence,
        current: generation,
        previous: z
          .strictObject({
            generation: NotificationGenerationSchema,
            expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .optional(),
      }),
    )
    .max(MAX_PAIRINGS)
    .refine((phones) => new Set(phones.map((p) => p.phoneFp)).size === phones.length),
});
type State = z.infer<typeof schema>;

/** Owned by the existing single agent/service process. Contains counters, never keys or labels. */
export class NotificationState {
  private data: State = { version: 1, phones: [] };
  private healthy = true;
  private readonly file: string;
  constructor(
    private readonly paths: Paths,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(paths.dir, "notifications.json");
    try {
      ensureDir(paths);
      const marker = join(paths.dir, "notifications.initialized");
      const initialized = optionalStat(marker) !== undefined;
      if (initialized && boundedRead(marker, 8, process.getuid?.()).toString("utf8") !== "v1\n")
        throw new Error("invalid marker");
      try {
        this.data = schema.parse(
          JSON.parse(boundedRead(this.file, 16_384, process.getuid?.()).toString("utf8")),
        );
      } catch (error) {
        if (initialized || !(error instanceof HostFileError && error.kind === "missing"))
          throw error;
        if (!this.commit(this.data)) return;
      }
      if (!initialized) {
        writeSecretFile(marker, "v1\n");
        this.syncDirectory();
      }
    } catch {
      this.healthy = false;
    }
  }
  private syncDirectory(): void {
    if (process.platform === "win32") return;
    const fd = openSync(this.paths.dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private commit(next: State): boolean {
    if (!this.healthy) return false;
    try {
      ensureDir(this.paths);
      writeSecretFile(this.file, JSON.stringify(next));
      // Persist the rename as well as the file contents before allowing encryption.
      this.syncDirectory();
      this.data = next;
      return true;
    } catch {
      this.healthy = false;
      return false;
    }
  }
  enroll(phoneFp: string, id: string): boolean {
    if (
      !this.healthy ||
      !FpSchema.safeParse(phoneFp).success ||
      !NotificationGenerationSchema.safeParse(id).success
    )
      return false;
    const old = this.data.phones.find((p) => p.phoneFp === phoneFp);
    if (old?.current.generation === id) return old.current.used < NOTIFICATION_LIMITS.encryptions;
    if (old?.previous?.generation === id || (!old && this.data.phones.length >= MAX_PAIRINGS))
      return false;
    const next = structuredClone(this.data);
    next.phones = next.phones.filter((p) => p.phoneFp !== phoneFp);
    next.phones.push({
      phoneFp,
      sequence: old?.sequence ?? "0",
      current: { generation: id, used: 0 },
      ...(old
        ? {
            previous: {
              generation: old.current.generation,
              expiresAt: this.now() + NOTIFICATION_LIMITS.previousGenerationMs,
            },
          }
        : {}),
    });
    return this.commit(next);
  }
  reserve(phoneFp: string): { generation: string; sequence: string } | undefined {
    if (!this.healthy) return undefined;
    const next = structuredClone(this.data);
    const phone = next.phones.find((p) => p.phoneFp === phoneFp);
    if (
      !phone ||
      phone.current.used >= NOTIFICATION_LIMITS.encryptions ||
      BigInt(phone.sequence) >= 18446744073709551615n
    )
      return undefined;
    phone.sequence = String(BigInt(phone.sequence) + 1n);
    phone.current.used++;
    if (phone.previous && phone.previous.expiresAt <= this.now()) delete phone.previous;
    return this.commit(next)
      ? { generation: phone.current.generation, sequence: phone.sequence }
      : undefined;
  }
  owns(phoneFp: string, generation: string): boolean {
    return (
      this.healthy &&
      this.data.phones.some((p) => p.phoneFp === phoneFp && p.current.generation === generation)
    );
  }
  forget(phoneFp: string): void {
    const next = structuredClone(this.data);
    next.phones = next.phones.filter((p) => p.phoneFp !== phoneFp);
    this.commit(next);
  }
}
