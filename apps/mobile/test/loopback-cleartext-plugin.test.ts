import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  loopbackCleartextManifest,
  loopbackCleartextInfoPlist,
  writeConfigs,
} = require("../plugins/with-loopback-cleartext.js");

describe("loopback cleartext", () => {
  it("allows iOS local networking while preserving the existing ATS policy", () => {
    const plist = loopbackCleartextInfoPlist({
      CFBundleDisplayName: "Shellbell",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    });
    expect(plist.CFBundleDisplayName).toBe("Shellbell");
    expect(plist.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    });
  });
  it("points the manifest at the network security config", () => {
    const document = { manifest: { application: [{ $: { "android:name": ".MainApplication" } }] } };
    loopbackCleartextManifest(document);
    expect(document.manifest.application[0]?.$).toEqual({
      "android:name": ".MainApplication",
      "android:networkSecurityConfig": "@xml/network_security_config",
    });
  });

  it("allows plain HTTP to 127.0.0.1 only in release, and everywhere in debug for Metro", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-nsc-"));
    writeConfigs(root);
    const read = (set: string) =>
      readFileSync(
        join(root, "app", "src", set, "res", "xml", "network_security_config.xml"),
        "utf8",
      );
    const release = read("main");
    expect(release).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(release).toMatch(
      /cleartextTrafficPermitted="true">\s*<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/,
    );
    expect(release.match(/<domain /g)).toHaveLength(1);
    expect(read("debug")).toContain('<base-config cleartextTrafficPermitted="true" />');
  });
});
