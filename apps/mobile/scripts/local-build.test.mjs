import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Android stages Firebase configuration before passing its relative path to Expo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-local-build-")));
  try {
    const mobile = join(dir, "mobile");
    const scripts = join(mobile, "scripts");
    const tools = join(dir, "tools");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(tools);
    const script = join(scripts, "local-build.mjs");
    copyFileSync(new URL("./local-build.mjs", import.meta.url), script);
    const firebase = join(dir, "private-firebase.json");
    const capture = join(dir, "captured-path");
    writeFileSync(firebase, "{}");
    writeFileSync(
      join(tools, "pnpm"),
      '#!/bin/sh\nprintf "%s" "$SHELLBELL_GOOGLE_SERVICES_FILE" > "$SHELLBELL_TEST_CAPTURE"\nexit 1\n',
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, [script, "android", "3"], {
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        SHELLBELL_GOOGLE_SERVICES_FILE: firebase,
        SHELLBELL_ANDROID_KEYSTORE: firebase,
        SHELLBELL_ANDROID_KEY_ALIAS: "alias",
        SHELLBELL_ANDROID_STORE_PASSWORD: "store-secret",
        SHELLBELL_ANDROID_KEY_PASSWORD: "key-secret",
        SHELLBELL_TEST_CAPTURE: capture,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Local pnpm step failed/);
    assert.equal(readFileSync(capture, "utf8"), "./google-services.json");
    assert.equal(readFileSync(join(mobile, "google-services.json"), "utf8"), "{}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
