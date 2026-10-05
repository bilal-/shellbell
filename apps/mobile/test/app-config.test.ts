import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";
import { afterEach, describe, expect, it } from "vitest";
import base from "../app.json";
import { mobileConfig } from "../config";
import appPackage from "../package.json";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function build(env: Record<string, string | undefined>) {
  return mobileConfig(base.expo as ExpoConfig, env);
}
function firebase(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "shellbell-config-"));
  dirs.push(dir);
  const file = join(dir, "google-services.json");
  writeFileSync(
    file,
    JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: id } } }] }),
  );
  return file;
}
describe("personal mobile build configuration", () => {
  it("uses the component version even when the supplied Expo base differs", () => {
    const config = mobileConfig({ ...base.expo, version: "9.9.9" } as ExpoConfig, {});
    expect(config.version).toBe(appPackage.version);
    expect(config.version).toBe(base.expo.version);
  });
  it("produces personal native IDs without exposing private environment values", async () => {
    const config = await build({ PRIVATE_KEY: "must-not-embed" });
    expect(config.ios?.bundleIdentifier).toBe("sh.bilal.shellbell");
    expect(config.android?.package).toBe("sh.bilal.shellbell");
    expect(config.owner).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("must-not-embed");
  });
  it("allows release builds without an Expo push project", async () => {
    expect((await build({ SHELLBELL_RELEASE_BUILD: "true" })).extra).toEqual({});
  });
  it("rejects a Firebase client registered to another Android application", async () => {
    await expect(
      build({ SHELLBELL_GOOGLE_SERVICES_FILE: firebase("invalid.other.app") }),
    ).rejects.toThrow(/Firebase/);
  });
  it("allows a matching Firebase client without a push project ID", async () => {
    const file = firebase("sh.bilal.shellbell");
    const config = await build({
      SHELLBELL_GOOGLE_SERVICES_FILE: file,
    });
    expect(config.android?.googleServicesFile).toBe(file);
    expect(config.extra).toEqual({});
  });
});
