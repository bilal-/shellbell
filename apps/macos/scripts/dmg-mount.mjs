import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reject } from "./signed-inventory.mjs";
import { runCaptured } from "./signed-verification.mjs";

const commandOptions = Object.freeze({ timeout: 60000, maxBuffer: 65536 });
const maxUncompressedBytes = 2 * 1024 ** 3;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function admitFormat(info) {
  const size = info?.["Size Information"]?.["Total Bytes"];
  if (
    !object(info) ||
    info.Format !== "UDZO" ||
    info.Properties?.Checksummed !== true ||
    info.Properties?.Compressed !== true ||
    info.Properties?.Encrypted !== false ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > maxUncompressedBytes
  )
    reject("dmg-format");
}
function admitMount(info, mountPoint) {
  const entities = info?.["system-entities"];
  if (!Array.isArray(entities) || entities.length === 0 || entities.some((item) => !object(item)))
    reject("dmg-mount-layout");
  const mounted = entities.filter((item) => Object.hasOwn(item, "mount-point"));
  if (
    mounted.length !== 1 ||
    mounted[0]["mount-point"] !== mountPoint ||
    mounted[0]["volume-kind"] !== "hfs" ||
    mounted[0]["content-hint"] !== "Apple_HFS" ||
    mounted[0]["potentially-mountable"] !== true ||
    entities.some((item) => item !== mounted[0] && item["potentially-mountable"] !== false)
  )
    reject("dmg-mount-layout");
}

/**
 * Internal mount mechanism, not publisher admission. The caller must verify the
 * image's expected publisher/signature before invoking it for distribution bytes.
 * Only the newly owned mount is detached; failed detach preserves all scratch.
 */
export async function withReadonlyDmg(image, inspect, { run: command = runCaptured } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-dmg-mount-")));
  const mountPoint = join(scratch, "volume");
  let attachAttempted = false;
  let operationFailed = false;
  let operationError;
  let result;
  let plistNumber = 0;
  async function plist(stdout) {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 65536) reject("dmg-plist");
    const input = join(scratch, `metadata-${plistNumber++}.plist`);
    writeFileSync(input, stdout, { flag: "wx", mode: 0o600 });
    const converted = await command(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", input],
      commandOptions,
    );
    if (typeof converted.stdout !== "string" || Buffer.byteLength(converted.stdout) > 65536)
      reject("dmg-plist");
    try {
      return JSON.parse(converted.stdout);
    } catch {
      reject("dmg-plist");
    }
  }
  try {
    mkdirSync(mountPoint, { mode: 0o700 });
    const info = await command("/usr/bin/hdiutil", ["imageinfo", "-plist", image], commandOptions);
    admitFormat(await plist(info.stdout));
    await command("/usr/bin/hdiutil", ["verify", image], commandOptions);
    // Even a rejected attach may have mounted before output/timeout failure.
    attachAttempted = true;
    const attached = await command(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-noautofsck",
        "-mountpoint",
        mountPoint,
        "-plist",
        image,
      ],
      commandOptions,
    );
    admitMount(await plist(attached.stdout), mountPoint);
    result = await inspect(mountPoint);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  if (attachAttempted) {
    try {
      await command("/usr/bin/hdiutil", ["detach", mountPoint], commandOptions);
    } catch (cause) {
      // Never recurse into a possibly mounted filesystem, even on a prior
      // failure. The operator gets the exact owned path for manual recovery.
      throw Object.assign(new Error("dmg-detach", { cause }), {
        code: "dmg-detach",
        mountPoint,
        scratch,
        operationError,
      });
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  if (operationFailed) throw operationError;
  return result;
}
