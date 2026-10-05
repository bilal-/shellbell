import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function planLocalBuild(platform, number, env) {
  if (!["android", "ios"].includes(platform)) throw new Error("Unsupported platform");
  if (!/^[1-9][0-9]*$/.test(number) || Number(number) > 2100000000)
    throw new Error("Invalid build number");
  const required = [
    ...(platform === "android"
      ? [
          "SHELLBELL_GOOGLE_SERVICES_FILE",
          "SHELLBELL_ANDROID_KEYSTORE",
          "SHELLBELL_ANDROID_KEY_ALIAS",
          "SHELLBELL_ANDROID_STORE_PASSWORD",
          "SHELLBELL_ANDROID_KEY_PASSWORD",
        ]
      : ["SHELLBELL_APPLE_TEAM_ID"]),
  ];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
  return [
    {
      command: "pnpm",
      args: ["exec", "expo", "prebuild", "--platform", platform, "--no-install"],
      directory: ".",
    },
    platform === "android"
      ? { command: "./gradlew", args: ["app:bundleRelease", "--no-daemon"], directory: "android" }
      : { command: "pod", args: ["install"], directory: "ios" },
  ];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [platform, number] = process.argv.slice(2);
    const steps = planLocalBuild(platform, number, process.env);
    if (platform === "android")
      for (const key of ["SHELLBELL_GOOGLE_SERVICES_FILE", "SHELLBELL_ANDROID_KEYSTORE"])
        accessSync(process.env[key], constants.R_OK);
    const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const step of steps) {
      const result = spawnSync(step.command, step.args, {
        cwd: resolve(mobile, step.directory),
        stdio: "inherit",
        env: { ...process.env, SHELLBELL_RELEASE_BUILD: "true", SHELLBELL_BUILD_NUMBER: number },
      });
      if (result.error || result.status !== 0) throw new Error(`Local ${step.command} step failed`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
