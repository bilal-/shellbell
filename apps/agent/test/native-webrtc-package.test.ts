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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const roots: string[] = [];
const policy = await import(
  pathToFileURL(resolve("../macos/scripts/native-loader-policy.mjs")).href
);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-native-policy-")));
  roots.push(root);
  const library = resolve(dirname(require.resolve("node-datachannel")), "../../..");
  const target = join(root, "node_modules/node-datachannel");
  mkdirSync(join(target, "dist/esm/lib"), { recursive: true });
  cpSync(join(library, "package.json"), join(target, "package.json"));
  const file = join(target, "dist/esm/lib/node-datachannel.mjs");
  cpSync(join(library, "dist/esm/lib/node-datachannel.mjs"), file);
  const native = dirname(require.resolve("@node-datachannel/darwin-arm64"));
  const platform = join(root, "node_modules/@node-datachannel/darwin-arm64");
  cpSync(native, platform, { recursive: true, dereference: true });
  const inside = (path: string) => {
    if (!path.startsWith(`${root}/`)) throw new Error("escaping target");
    return path;
  };
  const text = readFileSync(file, "utf8");
  const follow = (_file: string, spec: string) => {
    expect(spec).toBe("detect-libc");
  };
  return {
    file,
    platform,
    text,
    target,
    admit: (arch = "arm64", input = text, signedAddonSha256?: string) =>
      policy.admitNativeLoader(file, input, arch, inside, follow, signedAddonSha256),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "pinned native WebRTC package",
  () => {
    it("admits only the pinned loader and platform binary", () => {
      const f = fixture();
      expect(f.admit()).toBe(true);
      expect(() => f.admit("x64")).toThrow(/not qualified/);
    });
    it("rejects loader and binary modifications", () => {
      const f = fixture();
      expect(() => f.admit("arm64", `${f.text}\n`)).toThrow(/integrity/);
      writeFileSync(join(f.platform, "node_datachannel.node"), "tampered");
      expect(() => f.admit()).toThrow(/integrity/);
    });
    it("rejects a preferred local native build", () => {
      const f = fixture();
      mkdirSync(join(f.target, "build"));
      writeFileSync(join(f.target, "build/node_datachannel.node"), "local");
      expect(() => f.admit()).toThrow(/local WebRTC/);
    });
    it("checks the signed payload digest while retaining loader and architecture checks", () => {
      const f = fixture();
      const addon = join(f.platform, "node_datachannel.node");
      const signed = Buffer.concat([readFileSync(addon), Buffer.from("signature fixture")]);
      writeFileSync(addon, signed);
      const digest = createHash("sha256").update(signed).digest("hex");
      expect(() => f.admit()).toThrow(/integrity/);
      expect(f.admit("arm64", f.text, digest)).toBe(true);
      expect(() => f.admit("arm64", `${f.text}\n`, digest)).toThrow(/loader integrity/);
      expect(() => f.admit("x64", f.text, digest)).toThrow(/not qualified/);
      expect(() => f.admit("arm64", f.text, "invalid")).toThrow(/digest invalid/);
      writeFileSync(addon, Buffer.concat([signed, Buffer.from("modified after signing")]));
      expect(() => f.admit("arm64", f.text, digest)).toThrow(/integrity/);
    });
  },
);
