import assert from "node:assert/strict";
import { test } from "node:test";

const module = await import("./local-build.mjs").catch(() => ({}));
test("rejects unknown platforms and invalid build numbers before invoking tools", () => {
  assert.equal(typeof module.planLocalBuild, "function");
  assert.throws(() => module.planLocalBuild("windows", "1", {}), /platform/);
  assert.throws(() => module.planLocalBuild("android", "0", {}), /number/);
});
test("Android release builds require push and signing configuration", () => {
  assert.equal(typeof module.planLocalBuild, "function");
  assert.throws(() => module.planLocalBuild("android", "3", {}), /SHELLBELL_/);
  const env = {
    SHELLBELL_GOOGLE_SERVICES_FILE: "/private/firebase.json",
    SHELLBELL_ANDROID_KEYSTORE: "/private/sign.jks",
    SHELLBELL_ANDROID_KEY_ALIAS: "alias",
    SHELLBELL_ANDROID_STORE_PASSWORD: "store-secret",
    SHELLBELL_ANDROID_KEY_PASSWORD: "key-secret",
  };
  const steps = module.planLocalBuild("android", "3", env);
  assert.equal(steps[0].command, "pnpm");
  assert.deepEqual(steps[0].args, [
    "exec",
    "expo",
    "prebuild",
    "--platform",
    "android",
    "--no-install",
  ]);
  assert.equal(steps[1].command, "./gradlew");
  assert.deepEqual(steps[1].args, ["app:bundleRelease", "--no-daemon"]);
  assert.doesNotMatch(JSON.stringify(steps), /store-secret|key-secret|upload|eas build/);
});
test("iOS generation does not invoke cloud build or require upload credentials", () => {
  assert.equal(typeof module.planLocalBuild, "function");
  const steps = module.planLocalBuild("ios", "4", {
    SHELLBELL_APPLE_TEAM_ID: "ABCDEFGHIJ",
  });
  assert.deepEqual(
    steps.map((step) => step.command),
    ["pnpm", "pod"],
  );
  assert.doesNotMatch(JSON.stringify(steps), /upload|eas/);
});
