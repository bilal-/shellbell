import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ServiceCommand } from "./service-command.js";

// Detection only: these identities never authorize peers or start legacy jobs.
const LEGACY_USER_LABELS = [
  "dev.bilalahmad.shellbell",
  "dev.bilalahmad.shellbell.host.agent",
  "dev.bilalahmad.shellbell.host.manual",
];
export async function assertNoLegacyRegistration(
  run: ServiceCommand,
  uid: number,
  homeDir?: string,
): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("Invalid service UID");
  const conflict = () =>
    new Error(
      "Legacy Shellbell installation requires migration before starting the new service; preserve identity and remove old registrations explicitly.",
    );
  if (homeDir) {
    for (const label of LEGACY_USER_LABELS) {
      try {
        lstatSync(join(homeDir, "Library", "LaunchAgents", `${label}.plist`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw conflict();
    }
  }
  for (const target of [
    ...LEGACY_USER_LABELS.map((label) => `gui/${uid}/${label}`),
    "system/dev.bilalahmad.shellbell.power",
  ]) {
    const result = await run("/bin/launchctl", ["print", target], {
      timeoutMs: 5000,
      maxOutputBytes: 65536,
      captureOutput: false,
    });
    if (result.exitCode === 0) throw conflict();
    if (result.exitCode !== 113)
      throw new Error("Could not verify legacy Shellbell registration absence");
  }
}
