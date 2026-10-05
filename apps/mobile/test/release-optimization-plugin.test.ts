import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  enableReleaseProperties,
  optimizeReleaseGradle,
} = require("../plugins/with-release-optimization.js");

describe("Android release optimization", () => {
  it("replaces contradictory overrides once while retaining other Gradle settings", () => {
    const properties = [
      { type: "comment", value: "Keep unrelated settings" },
      { type: "property", key: "org.gradle.jvmargs", value: "-Xmx2048m" },
      { type: "property", key: "android.enableMinifyInReleaseBuilds", value: "false" },
      { type: "property", key: "android.enableMinifyInReleaseBuilds", value: "false" },
      { type: "property", key: "android.enableShrinkResourcesInReleaseBuilds", value: "false" },
    ];
    const optimized = enableReleaseProperties(properties);
    expect(optimized.slice(0, 2)).toEqual(properties.slice(0, 2));
    expect(optimized.slice(2)).toHaveLength(3);
    expect(optimized.slice(2).every((item: { value: string }) => item.value === "true")).toBe(true);
    expect(enableReleaseProperties(optimized)).toEqual(optimized);
  });

  it("uses optimizing defaults without widening the app's keep rules", () => {
    const gradle = `
      def minify = findProperty('android.enableMinifyInReleaseBuilds')
      def shrink = findProperty('android.enableShrinkResourcesInReleaseBuilds')
      release {
        proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
      }
      debug { signingConfig signingConfigs.debug }
    `;
    const optimized = optimizeReleaseGradle(gradle);
    expect(optimized).toContain('getDefaultProguardFile("proguard-android-optimize.txt")');
    expect(optimized).toContain('"proguard-rules.pro"');
    expect(optimized).toContain("debug { signingConfig signingConfigs.debug }");
    expect(optimizeReleaseGradle(optimized)).toBe(optimized);
  });

  it("fails native generation rather than silently accepting an unsupported template", () => {
    expect(() => optimizeReleaseGradle("android {} ")).toThrow(/template/);
  });
});
