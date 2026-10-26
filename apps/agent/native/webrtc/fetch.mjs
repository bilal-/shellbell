#!/usr/bin/env node
// Puts the pinned WebRTC binaries where runtime/webrtc-native.mjs loads them
// (apps/agent/webrtc/<target>/node_datachannel.node), from a local build (--from DIR, as
// build.mjs writes it) or from the release webrtc.json names. Every binary must match its pin.
//
//   node apps/agent/native/webrtc/fetch.mjs [--from ABS_DIR] [TARGET ...]   (default: this machine)
//   node apps/agent/native/webrtc/fetch.mjs --verify TARGET ...   (exactly these, as pinned)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(readFileSync(join(here, "webrtc.json"), "utf8"));
export const webrtcRoot = resolve(here, "../../webrtc");
export const TARGETS = Object.keys(pins.binaries);
const HOST = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The installed binary for `target`, after checking it still matches its pin. */
export function verifiedBinary(target, root = webrtcRoot) {
  const pin = pins.binaries[target];
  if (!pin) throw new Error(`No pinned WebRTC binary for ${target}`);
  const path = join(root, target, "node_datachannel.node");
  if (sha256(readFileSync(path)) !== pin.sha256)
    throw new Error(`${path} does not match its pin in webrtc.json`);
  return path;
}

/** Checks the installed binaries are exactly `targets`, each matching its pin. */
export function verifyInstalled(targets) {
  const present = existsSync(webrtcRoot) ? readdirSync(webrtcRoot).sort() : [];
  if (present.join() !== [...targets].sort().join())
    throw new Error(`webrtc/ holds ${present.join(", ") || "nothing"}, not ${targets.join(", ")}`);
  for (const target of targets) {
    if (readdirSync(join(webrtcRoot, target)).join() !== "node_datachannel.node")
      throw new Error(`webrtc/${target} holds more than its binary`);
    verifiedBinary(target);
  }
}

export function install(target, from) {
  const pin = pins.binaries[target];
  if (!pin) throw new Error(`No pinned WebRTC binary for ${target}`);
  const scratch = mkdtempSync(join(tmpdir(), "shellbell-webrtc-"));
  try {
    let source = join(scratch, "node_datachannel.node");
    if (from) source = join(from, target, "node_datachannel.node");
    else
      execFileSync(
        "curl",
        ["-fsSL", "-o", source, `${pins.release}/node_datachannel-${target}.node`],
        {
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
    if (sha256(readFileSync(source)) !== pin.sha256)
      throw new Error(`The ${target} WebRTC binary does not match its pin in webrtc.json`);
    const destination = join(webrtcRoot, target, "node_datachannel.node");
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, 0o755);
    return destination;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    verifyInstalled(args.slice(1));
    process.exit(0);
  }
  let from;
  if (args[0] === "--from") {
    from = args[1];
    args.splice(0, 2);
    if (!isAbsolute(from ?? "")) throw new Error("--from needs an absolute directory");
  }
  const targets = args.length ? args : [HOST[`${process.platform}-${process.arch}`]];
  for (const target of targets) console.log(install(target, from));
}
