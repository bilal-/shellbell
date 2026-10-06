import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

// Exact upstream loader bytes, not an exception for arbitrary computed imports.
const loaders = {
  "dist/esm/lib/node-datachannel.mjs":
    "2321881711bc78365d05444a183ba936644891c679460daaaad0965aff237218",
  "dist/cjs/lib/node-datachannel.cjs":
    "387462e3083642fe47dd2d3e3bc6af69de3df7959346e1aeb8a688eaec479df7",
};
const binaries = {
  arm64: {
    package: "@node-datachannel/darwin-arm64",
    sha256: "a4d98fdf75e9357b7d184653479ef805ce8faf74b10d31514cfe1bbb28b839ef",
    cpu: 0x0100000c,
    os: "darwin",
    arch: "arm64",
  },
  "linux-arm64": {
    package: "@node-datachannel/linux-arm64-gnu",
    sha256: "aa24fb23f02aa23446b6de01aef978d463b8e0e4a498a0b747675b7244749613",
    cpu: 183,
    os: "linux",
    arch: "arm64",
  },
  "linux-x64": {
    package: "@node-datachannel/linux-x64-gnu",
    sha256: "936d991f99cc07a48a8327199ca5ba098411f8b873dfe1a456069f09d64c52ff",
    cpu: 62,
    os: "linux",
    arch: "x64",
  },
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function admitNativeLoader(file, text, target, inside, follow, signedAddonSha256) {
  let root = dirname(file);
  for (let level = 0; level < 3; level++) root = dirname(root);
  const key = relative(root, file);
  if (!Object.hasOwn(loaders, key)) return false;
  const pkg = JSON.parse(readFileSync(inside(join(root, "package.json")), "utf8"));
  if (pkg.name !== "node-datachannel" || pkg.version !== "0.33.4") return false;
  if (digest(text) !== loaders[key]) throw new Error("native loader integrity mismatch");
  if (!Object.hasOwn(binaries, target))
    throw new Error("native WebRTC target architecture not qualified");
  // The loader prefers local builds. They must be wholly absent in distribution.
  for (const suffix of [
    "../../build/node_datachannel.node",
    "../../../build/node_datachannel.node",
    "../../build/Release/node_datachannel.node",
    "../../../build/Release/node_datachannel.node",
    "../../build/Debug/node_datachannel.node",
    "../../../build/Debug/node_datachannel.node",
  ]) {
    if (existsSync(resolve(dirname(file), suffix)))
      throw new Error("unexpected local WebRTC binary");
  }
  const spec = binaries[target];
  const addon = inside(createRequire(file).resolve(spec.package));
  const platform = JSON.parse(readFileSync(inside(join(dirname(addon), "package.json")), "utf8"));
  if (
    platform.name !== spec.package ||
    platform.version !== pkg.version ||
    platform.main !== "node_datachannel.node" ||
    platform.os?.join() !== spec.os ||
    platform.cpu?.join() !== spec.arch ||
    (spec.os === "linux" && platform.libc?.join() !== "glibc")
  )
    throw new Error("native WebRTC package metadata mismatch");
  const bytes = readFileSync(addon);
  // Candidate verification supplies its admitted payload digest after signing.
  // Development bundles retain the pinned upstream digest. Publisher signatures
  // are independently verified before executing any packaged runtime.
  if (spec.os === "linux" && signedAddonSha256 !== undefined)
    throw new Error("native WebRTC signing override is macOS-only");
  const expected = signedAddonSha256 ?? spec.sha256;
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
  follow(file, "detect-libc", "import", null);
  return true;
}
