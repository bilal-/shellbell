import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const policy = await import(
  pathToFileURL(resolve("../macos/scripts/native-loader-policy.mjs")).href
);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** A stand-in binary with the right file header for its platform; it is never loaded. */
function binary(target: string) {
  const bytes = Buffer.alloc(128);
  if (target === "arm64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  } else {
    bytes.write("7f454c460201", 0, "hex");
    bytes.writeUInt16LE(target === "linux-x64" ? 62 : 183, 18);
  }
  return bytes;
}
function fixture(target = "arm64") {
  const agent = realpathSync(mkdtempSync(join(tmpdir(), "sb-native-policy-")));
  roots.push(agent);
  const file = join(agent, "runtime/webrtc-native.mjs");
  mkdirSync(join(agent, "runtime"));
  cpSync(resolve("runtime/webrtc-native.mjs"), file);
  const addon = join(agent, policy.webrtcBinaryPath(target));
  mkdirSync(resolve(addon, ".."), { recursive: true });
  writeFileSync(addon, binary(target));
  const inside = (path: string) => {
    if (!path.startsWith(`${agent}/`)) throw new Error("escaping target");
    return path;
  };
  const text = readFileSync(file, "utf8");
  return {
    agent,
    addon,
    text,
    admit: (arch = target, input = text, signedAddonSha256?: string) =>
      policy.admitNativeLoader(agent, file, input, arch, inside, signedAddonSha256),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("pinned native WebRTC binary", () => {
  it("ignores every file but the loader", () => {
    const f = fixture();
    expect(
      policy.admitNativeLoader(f.agent, join(f.agent, "dist/cli.js"), "", "arm64", String),
    ).toBe(false);
  });
  it("loads only the binary pinned for the platform", () => {
    const f = fixture();
    // The stand-in is not the pinned build, so only a supplied digest admits it.
    expect(() => f.admit()).toThrow(/integrity/);
    expect(f.admit("arm64", f.text, digest(readFileSync(f.addon)))).toBe(true);
    expect(() => f.admit("x64")).toThrow(/not qualified/);
  });
  it("rejects loader changes", () => {
    const f = fixture();
    const sha = digest(readFileSync(f.addon));
    expect(() => f.admit("arm64", `${f.text}\n`, sha)).toThrow(/loader integrity/);
  });
  it("ships only this platform's binary, alone in its folder", () => {
    const f = fixture();
    const sha = digest(readFileSync(f.addon));
    mkdirSync(join(f.agent, "webrtc/darwin-x64"));
    expect(() => f.admit("arm64", f.text, sha)).toThrow(/layout/);
    rmSync(join(f.agent, "webrtc/darwin-x64"), { recursive: true });
    writeFileSync(join(f.agent, "webrtc/darwin-arm64/extra.node"), "");
    expect(() => f.admit("arm64", f.text, sha)).toThrow(/layout/);
  });
  it("checks the signed payload digest while retaining architecture checks", () => {
    const f = fixture();
    const signed = Buffer.concat([readFileSync(f.addon), Buffer.from("signature fixture")]);
    writeFileSync(f.addon, signed);
    expect(f.admit("arm64", f.text, digest(signed))).toBe(true);
    expect(() => f.admit("arm64", f.text, "invalid")).toThrow(/digest invalid/);
    writeFileSync(f.addon, Buffer.concat([signed, Buffer.from("modified after signing")]));
    expect(() => f.admit("arm64", f.text, digest(signed))).toThrow(/integrity/);
    const wrong = binary("linux-x64");
    writeFileSync(f.addon, wrong);
    expect(() => f.admit("arm64", f.text, digest(wrong))).toThrow(/architecture/);
  });
  it.each(["linux-arm64", "linux-x64"])("holds the %s binary to its pin", (target) => {
    const f = fixture(target);
    expect(() => f.admit()).toThrow(/integrity/);
    expect(() => f.admit(target, f.text, digest(readFileSync(f.addon)))).toThrow(/macOS-only/);
  });
});
