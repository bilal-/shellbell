#!/usr/bin/env node
// Builds the native WebRTC binary (node_datachannel.node) from the sources pinned in webrtc.json:
// node-datachannel's bindings, a newer libdatachannel than its own pin, and OpenSSL 3.5 LTS linked
// statically. Linux targets build in the pinned Debian bullseye image (glibc 2.31, as upstream);
// the macOS target builds on this Mac. Prints each binary's SHA-256 for webrtc.json.
//
//   node apps/agent/native/webrtc/build.mjs --target darwin-arm64|darwin-x64|linux-x64-gnu|linux-arm64-gnu|all --output ABS_NEW_DIR
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, "webrtc.json"), "utf8"));
export const TARGETS = {
  "darwin-arm64": { os: "darwin", arch: "arm64", cmake: "darwin" },
  // For npm installs on Intel Macs; cross-built on an Apple silicon Mac.
  "darwin-x64": { os: "darwin", arch: "x64", cmake: "darwin" },
  "linux-x64-gnu": { os: "linux", docker: "linux/amd64", cmake: "linux-x64" },
  "linux-arm64-gnu": { os: "linux", docker: "linux/arm64", cmake: "linux-arm64" },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], ...options });

function checkout({ repository, commit }, destination, submodules) {
  run("git", ["init", "-q", destination]);
  run("git", ["-C", destination, "fetch", "-q", "--depth", "1", repository, commit]);
  run("git", ["-C", destination, "checkout", "-q", "FETCH_HEAD"]);
  const head = execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.trim() !== commit) throw new Error(`${repository} is not at ${commit}`);
  if (submodules)
    run("git", [
      "-C",
      destination,
      "submodule",
      "update",
      "-q",
      "--init",
      "--recursive",
      "--depth",
      "1",
    ]);
}

function download(url, expected, destination) {
  run("curl", ["-fsSL", "-o", destination, url]);
  if (sha256(readFileSync(destination)) !== expected) throw new Error(`${url} checksum mismatch`);
}

/** Fetches every source once; git checks each commit, and each download's checksum is checked. */
function fetchSources(src, targets) {
  checkout(pins.nodeDatachannel, join(src, "node-datachannel"), false);
  checkout(pins.libdatachannel, join(src, "libdatachannel"), true);
  download(pins.openssl.url, pins.openssl.sha256, join(src, "openssl.tar.gz"));
  // Kitware's own CMake build for each target, rather than whatever the host or image has.
  for (const host of new Set(targets.map((target) => TARGETS[target].cmake))) {
    const { url, sha256: expected } = pins.cmake.archives[host];
    const tools = join(src, "cmake", host);
    mkdirSync(tools, { recursive: true });
    download(url, expected, join(tools, "cmake.tar.gz"));
    run("tar", ["-xzf", join(tools, "cmake.tar.gz"), "-C", tools, "--strip-components", "1"]);
  }
}

function build(target, src, output) {
  const spec = TARGETS[target];
  const out = join(output, target);
  mkdirSync(out, { recursive: true });
  if (spec.os === "darwin") {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error(`${target} builds on an Apple silicon Mac`);
    run("sh", [join(here, "build-inside.sh"), src, out, spec.arch], {
      env: {
        ...process.env,
        PATH: `${join(src, "cmake", "darwin", "CMake.app/Contents/bin")}:${process.env.PATH}`,
        MACOSX_DEPLOYMENT_TARGET: pins.macosDeploymentTarget,
      },
    });
  } else {
    run("docker", [
      "run",
      "--rm",
      "--platform",
      spec.docker,
      "-v",
      `${src}:/src:ro`,
      "-v",
      `${here}/build-inside.sh:/build-inside.sh:ro`,
      "-v",
      `${out}:/out`,
      pins.linuxImage,
      "env",
      `PATH=/src/cmake/${spec.cmake}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      `JOBS=${process.env.JOBS ?? 4}`,
      "sh",
      "/build-inside.sh",
      "/src",
      "/out",
    ]);
  }
  return sha256(readFileSync(join(out, "node_datachannel.node")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (index % 2 === 0) pairs.push([value, all[index + 1]]);
      return pairs;
    }, []),
  );
  const output = args["--output"];
  const targets = args["--target"] === "all" ? Object.keys(TARGETS) : [args["--target"]];
  if (!isAbsolute(output ?? "") || existsSync(output) || !targets.every((t) => TARGETS[t]))
    throw new Error(
      "usage: build.mjs --target darwin-arm64|darwin-x64|linux-x64-gnu|linux-arm64-gnu|all --output ABS_NEW_DIR",
    );
  const src = mkdtempSync(join(tmpdir(), "shellbell-webrtc-src-"));
  try {
    fetchSources(src, targets);
    const binaries = {};
    for (const target of targets) binaries[target] = { sha256: build(target, src, output) };
    writeFileSync(join(output, "binaries.json"), `${JSON.stringify(binaries, null, 2)}\n`);
    console.log(JSON.stringify(binaries, null, 2));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}
