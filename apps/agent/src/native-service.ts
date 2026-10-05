#!/usr/bin/env node
import { createReadStream, fstatSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { paths } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { inspectBundleRuntime } from "./native/bundle-runtime.js";
import { NativeExecutionKindSchema } from "./native/protocol.js";
import { runNativeService, sanitizeNativeEnvironment } from "./native/service-entry.js";

async function main() {
  if (process.argv.length === 3 && ["--help", "--version"].includes(process.argv[2]!)) {
    process.stdout.write(
      process.argv[2] === "--version" ? `${pkg.version}\n` : "Shellbell native service\n",
    );
    return;
  }
  const mode = NativeExecutionKindSchema.parse(process.argv[2]);
  if (
    process.argv.length !== 3 ||
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
  const owner = await runNativeService(mode, {
    ...(mode === "desktop"
      ? {
          ownerInput: (() => {
            const stat = fstatSync(3);
            if (!stat.isFIFO() && !stat.isSocket()) throw new Error("invalid owner channel");
            return createReadStream("", { fd: 3, autoClose: true });
          })(),
          onOwnerLost: (error: unknown | null) => process.exit(error === null ? 0 : 1),
        }
      : {}),
    bundlePath,
    root,
    uid: account.uid,
    async start(selection) {
      if (selection.agentVersion !== runtime.agentVersion) throw new Error();
      const environment = sanitizeNativeEnvironment(selection, account.homedir, process.env);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, environment);
      // Dynamic URL keeps the CLI in its own module: its direct-entry guard must never
      // be inlined into this entry bundle and mistake the native process for CLI start.
      const engineUrl = new URL("./cli.js", import.meta.url).href;
      const { buildAgent, shutdown } = (await import(engineUrl)) as typeof import("./cli.js");
      const p = paths(selection.stateDir),
        sink = createLogger({ file: p.log, stdout: false });
      const log: Logger = {
        debug: () => {},
        info: () => sink.info("agent-event"),
        warn: () => sink.warn("agent-event"),
        error: () => sink.error("agent-event"),
        child: () => log,
      };
      const engine = await buildAgent(log, undefined, false, {
        paths: p,
        serviceInstance: selection.serviceInstance,
        nativeService: true,
      });
      try {
        await engine.control.start();
        engine.agent.start();
      } catch (error) {
        engine.stopBackendDetectors();
        engine.agent.stop();
        await engine.control.stop();
        throw error;
      }
      let stopping: Promise<void> | undefined;
      return {
        stop() {
          stopping ??= shutdown(
            engine.agent,
            engine.control,
            (code) => {
              if (code) process.exit(1);
            },
            engine.stopBackendDetectors,
          );
          return stopping;
        },
      };
    },
  });
  const stop = () => {
    void owner.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(() => {
    process.stderr.write("Shellbell service unavailable\n");
    process.exitCode = 1;
  });
