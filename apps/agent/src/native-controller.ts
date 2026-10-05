#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { runNativeBridge } from "./native/bridge.js";
import { inspectBundleRuntime } from "./native/bundle-runtime.js";
import { NativeCoordinator } from "./native/coordinator.js";
import { createNativePlatform } from "./native/platform.js";
import { NativeRecordStore } from "./native/record-store.js";

async function main() {
  if (process.argv.length === 3 && ["--help", "--version"].includes(process.argv[2]!)) {
    process.stdout.write(
      process.argv[2] === "--version" ? `${pkg.version}\n` : "Shellbell native controller\n",
    );
    return;
  }
  if (
    process.argv.length !== 2 ||
    process.execArgv.length ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH
  )
    throw new Error();
  const account = userInfo();
  if (process.platform !== "darwin" || account.uid <= 0) throw new Error();
  const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const runtime = await inspectBundleRuntime(bundlePath);
  if (runtime.agentVersion !== pkg.version) throw new Error();
  const root = join(account.homedir, "Library/Application Support/Shellbell");
  const coordinator = new NativeCoordinator({
    store: new NativeRecordStore({ root, uid: account.uid }),
    platform: createNativePlatform({ root, uid: account.uid, homeDir: account.homedir }),
    bundlePath,
    uid: account.uid,
    homeDir: account.homedir,
    agentVersion: pkg.version,
    defaultStateDir: join(account.homedir, ".shellbell"),
  });
  const bridge = runNativeBridge(process.stdin, process.stdout, coordinator, {
    agentVersion: pkg.version,
  });
  const close = () => {
    void bridge.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(() => {
    process.stderr.write("Shellbell controller unavailable\n");
    process.exitCode = 1;
  });
