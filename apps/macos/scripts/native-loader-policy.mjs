import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const pins = JSON.parse(
  readFileSync(new URL("../../agent/native/webrtc/webrtc.json", import.meta.url), "utf8"),
);
// Exact loader bytes, not an exception for arbitrary computed imports.
const loader = {
  path: "runtime/webrtc-native.mjs",
  sha256: "4bac246e117cc6b2d922b078e66d465ed232f2dd37b6314a61ece4f6a3cb4789",
};
// Packaging targets, and the pinned binary each one ships.
const binaries = {
  arm64: { target: "darwin-arm64", cpu: 0x0100000c, os: "darwin" },
  "linux-arm64": { target: "linux-arm64-gnu", cpu: 183, os: "linux" },
  "linux-x64": { target: "linux-x64-gnu", cpu: 62, os: "linux" },
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = (path) => readdirSync(path).sort().join();
/** The WebRTC binary a package for `target` ships, inside the agent folder. */
export function webrtcBinaryPath(target) {
  if (!Object.hasOwn(binaries, target))
    throw new Error("native WebRTC target architecture not qualified");
  return `webrtc/${binaries[target].target}/node_datachannel.node`;
}
export function admitNativeLoader(agent, file, text, target, inside, signedAddonSha256) {
  if (relative(agent, file) !== loader.path) return false;
  if (digest(text) !== loader.sha256) throw new Error("native loader integrity mismatch");
  if (!Object.hasOwn(binaries, target))
    throw new Error("native WebRTC target architecture not qualified");
  const spec = binaries[target];
  // Only this platform's binary ships, alone in its folder.
  if (
    entries(join(agent, "webrtc")) !== spec.target ||
    entries(join(agent, "webrtc", spec.target)) !== "node_datachannel.node" ||
    !lstatSync(join(agent, "webrtc", spec.target)).isDirectory()
  )
    throw new Error("unexpected WebRTC binary layout");
  const bytes = readFileSync(inside(join(agent, webrtcBinaryPath(target))));
  // Candidate verification supplies its admitted payload digest after signing.
  // Development bundles retain the pinned build digest. Publisher signatures
  // are independently verified before executing any packaged runtime.
  if (spec.os === "linux" && signedAddonSha256 !== undefined)
    throw new Error("native WebRTC signing override is macOS-only");
  const expected = signedAddonSha256 ?? pins.binaries[spec.target]?.sha256;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("native WebRTC binary digest invalid");
  const architectureMatches =
    spec.os === "linux"
      ? bytes.length >= 64 &&
        bytes.subarray(0, 6).toString("hex") === "7f454c460201" &&
        bytes.readUInt16LE(18) === spec.cpu
      : bytes.length >= 8 &&
        bytes.readUInt32LE(0) === 0xfeedfacf &&
        bytes.readUInt32LE(4) === spec.cpu;
  if (digest(bytes) !== expected || !architectureMatches)
    throw new Error("native WebRTC binary integrity or architecture mismatch");
  return true;
}
