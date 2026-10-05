import { createHmac } from "node:crypto";
import { boundedRead } from "./host-files.js";

export interface LinuxMachineOptions {
  uid?: number;
  euid?: number;
  machineIdPath?: string;
}
export interface LinuxMachineIdentity {
  uid: number;
  machineId: string;
  hostDigest: string;
  hostScope: string;
}

/** Private local identity: never serialize machineId in public status or Paths. */
export function readLinuxMachineIdentity(options: LinuxMachineOptions = {}): LinuxMachineIdentity {
  const uid = options.uid ?? process.getuid?.();
  const euid = options.euid ?? process.geteuid?.();
  if (!Number.isInteger(uid) || uid === undefined || uid <= 0 || uid !== euid)
    throw new Error("shellbell: Linux hosting requires matching non-root real and effective users");
  let machine: Buffer;
  try {
    const text = boundedRead(
      options.machineIdPath ?? "/etc/machine-id",
      256,
      undefined,
      false,
    ).toString("utf8");
    if (!/^[0-9a-fA-F]{32}\n?$/.test(text) || /^0{32}\n?$/.test(text)) throw new Error();
    machine = Buffer.from(text.trim().toLowerCase(), "hex");
  } catch {
    throw new Error(
      "shellbell: Linux machine identity is unavailable or invalid; provision /etc/machine-id before host initialization",
    );
  }
  const hostDigest = createHmac("sha256", "shellbell.local-host-scope.v1")
    .update(machine)
    .digest("hex");
  const hostScope = hostDigest.slice(0, 32);
  return { uid, machineId: machine.toString("hex"), hostDigest, hostScope };
}
