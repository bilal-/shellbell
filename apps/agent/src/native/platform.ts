import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { boundedRead, optionalStat, sameFile } from "../host-files.js";
import { createLaunchdManager } from "../launchd.js";
import { assertNoLegacyRegistration } from "../legacy-installation.js";
import { runServiceCommand, type ServiceCommand } from "../service-command.js";
import { withServiceDefinitionGuard } from "../service-lifecycle.js";
import type { ServiceManager, ServiceSnapshot } from "../service-manager.js";
import { assertNativeAncestors, createManualJob, MANUAL_LABEL } from "./manual-job.js";
import {
  NativeControllerError,
  NativeHelperResponseSchema,
  type NativeJob,
  type NativeMode,
  NativePathSchema,
  type NativeSelection,
  NativeSelectionSchema,
  requireNativeManagerMode,
} from "./protocol.js";

const PERSISTENT_LABEL = "sh.bilal.shellbell.host.agent";
const OUTPUT_BYTES = 65536;
function unsafe(): never {
  throw new NativeControllerError("unsafe-state");
}
function bundleExecutable(bundle: string): string {
  if (
    !NativePathSchema.safeParse(bundle).success ||
    bundle !== join(bundle) ||
    basename(bundle) !== "Shellbell.app"
  )
    unsafe();
  const executable = join(bundle, "Contents", "MacOS", "Shellbell");
  if (!NativePathSchema.safeParse(executable).success) unsafe();
  return executable;
}
async function command(
  run: ServiceCommand,
  executable: string,
  args: readonly string[],
  input?: Uint8Array,
  mutation = false,
  timeoutMs = 10000,
) {
  try {
    const result = await run(executable, args, {
      input,
      timeoutMs,
      maxOutputBytes: OUTPUT_BYTES,
      captureOutput: true,
    });
    if (
      !Number.isInteger(result.exitCode) ||
      result.exitCode < 0 ||
      result.exitCode > 255 ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length > OUTPUT_BYTES
    )
      throw new Error("invalid command result");
    return result;
  } catch {
    throw new NativeControllerError(mutation ? "delivery-unknown" : "unavailable");
  }
}
function sameMetadata(a: Stats, b: Stats): boolean {
  return (
    sameFile(a, b) &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
/** Focused helper admission seam. Task 4 additionally validates the complete runtime closure. */
export async function validateNativeBundleHelper(
  bundle: string,
  uid: number,
  run: ServiceCommand = runServiceCommand,
): Promise<{ executable: string; revalidate(): void }> {
  const executable = bundleExecutable(bundle);
  const info = join(bundle, "Contents", "Info.plist");
  const entries = new Map<string, Stats>();
  const observe = () => {
    assertNativeAncestors(dirname(bundle));
    for (const path of [
      bundle,
      join(bundle, "Contents"),
      join(bundle, "Contents", "MacOS"),
      info,
      executable,
    ]) {
      const stat = optionalStat(path);
      const file = path === info || path === executable;
      if (
        !stat ||
        stat.isSymbolicLink() ||
        (file ? !stat.isFile() : !stat.isDirectory()) ||
        (stat.uid !== uid && stat.uid !== 0) ||
        (stat.mode & 0o7022) !== 0 ||
        (path === executable && (stat.mode & 0o111) === 0)
      )
        unsafe();
      const prior = entries.get(path);
      if (prior && !sameMetadata(prior, stat)) unsafe();
      entries.set(path, stat);
    }
  };
  try {
    observe();
    const bytes = boundedRead(info, OUTPUT_BYTES);
    const result = await command(
      run,
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "-"],
      bytes,
    );
    if (result.exitCode !== 0) unsafe();
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
      metadata?.CFBundleIdentifier !== "sh.bilal.shellbell.host" ||
      metadata?.CFBundleExecutable !== "Shellbell"
    )
      unsafe();
    observe();
    return { executable, revalidate: observe };
  } catch {
    return unsafe();
  }
}

/** launchctl print has no stable machine format: unfamiliar/ambiguous output fails closed. */
function parseJob(
  stdout: Buffer,
  target: string,
  executable: string,
  mode: NativeMode,
): number | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return unsafe();
  }
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines.shift() !== `${target} = {` || lines.pop() !== "}") unsafe();
  let depth = 1;
  let program: string | undefined;
  let pid: number | null = null;
  let sawPid = false;
  let args: string[] | undefined;
  let inArgs = false;
  for (const line of lines) {
    if (!line) continue;
    if (line === "}") {
      if (depth <= 1) unsafe();
      if (inArgs && depth === 2) inArgs = false;
      depth--;
      continue;
    }
    if (depth === 1 && line.startsWith("program = ")) {
      if (program !== undefined) unsafe();
      program = line.slice(10);
      continue;
    }
    if (depth === 1 && line.startsWith("pid = ")) {
      if (sawPid || !/^pid = [1-9][0-9]*$/.test(line)) unsafe();
      sawPid = true;
      pid = Number(line.slice(6));
      if (!Number.isSafeInteger(pid) || pid > 2147483647) unsafe();
      continue;
    }
    if (depth === 1 && /^(?:pid|program|arguments)(?:\s|=)/.test(line) && line !== "arguments = {")
      unsafe();
    if (line.endsWith("= {")) {
      if (depth === 1 && line === "arguments = {") {
        if (args !== undefined) unsafe();
        args = [];
        inArgs = true;
      } else if (inArgs) unsafe();
      depth++;
      continue;
    }
    if (inArgs && depth === 2) args!.push(line);
    else if (line.includes("{") || line.includes("}")) unsafe();
  }
  if (
    depth !== 1 ||
    program !== executable ||
    !args ||
    args.length !== 3 ||
    args[0] !== (mode === "persistent" ? "Shellbell" : executable) ||
    args[1] !== "--service-run" ||
    args[2] !== mode
  )
    unsafe();
  return pid;
}

export interface NativePlatform {
  loginStatus(bundlePath: string): Promise<NativeJob["registration"]>;
  setLogin(bundlePath: string, enabled: boolean): Promise<NativeJob["registration"]>;
  preflight(mode: NativeMode, bundlePath: string): Promise<void>;
  prepareManualRecovery(selection: NativeSelection): Promise<void>;
  inspectLegacy(): Promise<ServiceSnapshot>;
  inspect(mode: NativeMode, bundlePath: string): Promise<NativeJob>;
  start(selection: NativeSelection): Promise<NativeJob>;
  stop(selection: NativeSelection, observed: NativeJob): Promise<void>;
  remove(selection: NativeSelection): Promise<void>;
  withLegacyGuard<T>(action: (manager: ServiceManager) => Promise<T>): Promise<T>;
}
export function createNativePlatform(options: {
  root: string;
  uid: number;
  homeDir: string;
  run?: ServiceCommand;
  legacy?: ServiceManager;
}): NativePlatform {
  const { root, uid, homeDir } = options;
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !NativePathSchema.safeParse(root).success ||
    !NativePathSchema.safeParse(homeDir).success ||
    root !== join(root) ||
    homeDir !== join(homeDir)
  )
    unsafe();
  const startup = join(homeDir, "Library", "LaunchAgents");
  if (root === startup || root.startsWith(`${startup}/`)) unsafe();
  const run = options.run ?? runServiceCommand;
  const manual = createManualJob(root, uid);
  const legacy = options.legacy ?? createLaunchdManager({ run, uid, homeDir });
  const domain = `gui/${uid}`;
  const target = (mode: NativeMode) =>
    `${domain}/${mode === "manual" ? MANUAL_LABEL : PERSISTENT_LABEL}`;
  const checkSelection = (selection: NativeSelection) => {
    if (!NativeSelectionSchema.safeParse(selection).success) unsafe();
  };
  async function helper(
    bundle: string,
    verb: "status" | "register" | "unregister",
    beforeMutation?: () => Promise<void>,
    api: "service" | "login" = "service",
  ): Promise<NativeJob["registration"]> {
    const validated = await validateNativeBundleHelper(bundle, uid, run);
    await beforeMutation?.();
    validated.revalidate();
    const mutation = verb !== "status";
    const result = await command(
      run,
      validated.executable,
      [api === "login" ? "--login-api" : "--service-api", verb],
      undefined,
      mutation,
    );
    validated.revalidate();
    let parsed: ReturnType<typeof NativeHelperResponseSchema.parse>;
    try {
      parsed = NativeHelperResponseSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)),
      );
    } catch {
      throw new NativeControllerError(mutation ? "delivery-unknown" : "unavailable");
    }
    if (!parsed.ok)
      throw new NativeControllerError(
        parsed.error.code === "denied"
          ? "approval-required"
          : parsed.error.code === "invalid-bundle"
            ? "unsafe-state"
            : "operation-failed",
      );
    if (result.exitCode !== 0)
      throw new NativeControllerError(mutation ? "delivery-unknown" : "unavailable");
    return parsed.status;
  }
  async function execution(mode: NativeMode, bundle: string, timeoutMs = 10000) {
    const result = await command(
      run,
      "/bin/launchctl",
      ["print", target(mode)],
      undefined,
      false,
      timeoutMs,
    );
    if (result.exitCode === 113) return { loaded: false, pid: null };
    if (result.exitCode !== 0) throw new NativeControllerError("unavailable");
    return {
      loaded: true,
      pid: parseJob(result.stdout, target(mode), bundleExecutable(bundle), mode),
    };
  }
  const platform: NativePlatform = {
    loginStatus: (bundle) => helper(bundle, "status", undefined, "login"),
    async setLogin(bundle, enabled) {
      const admitted = await validateNativeBundleHelper(bundle, uid, run);
      const signature = await command(run, "/usr/bin/codesign", ["--verify", "--strict", bundle]);
      admitted.revalidate();
      if (signature.exitCode !== 0) throw new NativeControllerError("startup-unavailable");
      const before = await helper(bundle, "status", undefined, "login");
      if (before === "not-found" || before === "unknown")
        throw new NativeControllerError("startup-unavailable");
      if (
        enabled
          ? before === "enabled" || before === "requires-approval"
          : before === "not-registered"
      )
        return before;
      try {
        await helper(bundle, enabled ? "register" : "unregister", undefined, "login");
      } catch (error) {
        if (
          !(
            enabled &&
            error instanceof NativeControllerError &&
            error.code === "approval-required" &&
            (await helper(bundle, "status", undefined, "login")) === "requires-approval"
          )
        )
          throw error;
      }
      const after = await helper(bundle, "status", undefined, "login");
      if (
        enabled ? after !== "enabled" && after !== "requires-approval" : after !== "not-registered"
      )
        throw new NativeControllerError("operation-failed");
      return after;
    },
    async preflight(mode, bundle) {
      await assertNoLegacyRegistration(run, uid, homeDir);
      const admitted = await validateNativeBundleHelper(bundle, uid, run);
      if (mode === "persistent") {
        const result = await command(run, "/usr/bin/codesign", ["--verify", "--strict", bundle]);
        admitted.revalidate();
        if (result.exitCode !== 0 || (await helper(bundle, "status")) === "not-found")
          throw new NativeControllerError("startup-unavailable");
      }
    },
    async prepareManualRecovery(selection) {
      await assertNoLegacyRegistration(run, uid, homeDir);
      checkSelection(selection);
      if (requireNativeManagerMode(selection.mode) !== "persistent") unsafe();
      const before = await platform.inspect("persistent", selection.bundlePath);
      if (before.loaded) throw new NativeControllerError("conflict");
      // Explicit recovery only: a broken development bundle can return not-found
      // even for unregister. Disabling the exact launchd label prevents later
      // approval/login from launching that old job. Never interpret not-found
      // alone as proof that automatic startup is disabled.
      const result = await command(
        run,
        "/bin/launchctl",
        ["disable", target("persistent")],
        undefined,
        true,
      );
      if (result.exitCode !== 0) throw new NativeControllerError("operation-failed");
      const disabled = await command(run, "/bin/launchctl", ["print-disabled", domain]);
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(disabled.stdout)
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim());
      if (
        disabled.exitCode !== 0 ||
        lines.shift() !== "disabled services = {" ||
        lines.pop() !== "}" ||
        lines.filter((line) => line.includes(`"${PERSISTENT_LABEL}"`)).join("\n") !==
          `"${PERSISTENT_LABEL}" => disabled`
      )
        throw new NativeControllerError("operation-failed");
      const after = await platform.inspect("persistent", selection.bundlePath);
      if (after.loaded) throw new NativeControllerError("conflict");
      if (after.registration !== "not-registered" && after.registration !== "not-found")
        await platform.stop(selection, after);
    },
    inspectLegacy: () => legacy.inspect(),
    async inspect(mode, bundle) {
      if (mode !== "manual" && mode !== "persistent") unsafe();
      const executable = bundleExecutable(bundle);
      let registration: NativeJob["registration"];
      if (mode === "manual")
        registration = manual.inspect(executable) ? "enabled" : "not-registered";
      else {
        assertNativeAncestors(dirname(bundle));
        registration = optionalStat(bundle) ? await helper(bundle, "status") : "not-found";
      }
      const job = await execution(mode, bundle);
      if (mode === "manual" && job.loaded && registration !== "enabled") unsafe();
      return { registration, ...job, bundlePath: bundle };
    },
    async start(selection) {
      checkSelection(selection);
      await platform.preflight(requireNativeManagerMode(selection.mode), selection.bundlePath);
      const before = await platform.inspect(
        requireNativeManagerMode(selection.mode),
        selection.bundlePath,
      );
      if (before.loaded) throw new NativeControllerError("conflict");
      if (requireNativeManagerMode(selection.mode) === "persistent") {
        // Only a new, explicitly requested persistent start may undo the
        // automatic-start override installed by manual recovery.
        const enabled = await command(
          run,
          "/bin/launchctl",
          ["enable", target("persistent")],
          undefined,
          true,
        );
        if (enabled.exitCode !== 0) throw new NativeControllerError("operation-failed");
        const registration = await helper(selection.bundlePath, "register", async () => {
          if ((await execution("persistent", selection.bundlePath)).loaded)
            throw new NativeControllerError("conflict");
        });
        return {
          registration,
          ...(await execution(requireNativeManagerMode(selection.mode), selection.bundlePath)),
          bundlePath: selection.bundlePath,
        };
      }
      const validated = await validateNativeBundleHelper(selection.bundlePath, uid, run);
      manual.write(validated.executable);
      if ((await execution("manual", selection.bundlePath)).loaded)
        throw new NativeControllerError("conflict");
      manual.inspect(validated.executable);
      validated.revalidate();
      const result = await command(
        run,
        "/bin/launchctl",
        ["bootstrap", domain, manual.path],
        undefined,
        true,
      );
      if (result.exitCode !== 0) throw new NativeControllerError("operation-failed");
      return platform.inspect("manual", selection.bundlePath);
    },
    async stop(selection, observed) {
      checkSelection(selection);
      if (observed.bundlePath !== selection.bundlePath) unsafe();
      const fresh = await platform.inspect(
        requireNativeManagerMode(selection.mode),
        selection.bundlePath,
      );
      if (
        fresh.loaded !== observed.loaded ||
        fresh.pid !== observed.pid ||
        fresh.registration !== observed.registration
      )
        throw new NativeControllerError("conflict");
      if (requireNativeManagerMode(selection.mode) === "persistent") {
        const registration = await helper(selection.bundlePath, "unregister", async () => {
          const latest = await execution("persistent", selection.bundlePath);
          if (latest.loaded !== fresh.loaded || latest.pid !== fresh.pid)
            throw new NativeControllerError("conflict");
        });
        if (registration !== "not-registered") throw new NativeControllerError("operation-failed");
      } else if (fresh.loaded) {
        manual.inspect(bundleExecutable(selection.bundlePath));
        const result = await command(
          run,
          "/bin/launchctl",
          ["bootout", target("manual")],
          undefined,
          true,
        );
        if (result.exitCode !== 0) throw new NativeControllerError("operation-failed");
      }
      // bootout/unregister can succeed while launchd still exposes a SIGTERMed
      // job. Observe its departure without replaying the mutation or accepting
      // a replacement process; each probe shares the same bounded deadline.
      const deadline = performance.now() + 10000;
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new NativeControllerError("operation-failed");
        const job = await execution(
          requireNativeManagerMode(selection.mode),
          selection.bundlePath,
          remaining,
        );
        if (!job.loaded) break;
        if (job.pid !== null && job.pid !== fresh.pid) throw new NativeControllerError("conflict");
        const delay = Math.min(100, deadline - performance.now());
        if (delay <= 0) throw new NativeControllerError("operation-failed");
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    },
    async remove(selection) {
      checkSelection(selection);
      const job = await platform.inspect(
        requireNativeManagerMode(selection.mode),
        selection.bundlePath,
      );
      if (
        job.loaded ||
        (requireNativeManagerMode(selection.mode) === "persistent" &&
          job.registration !== "not-registered")
      )
        throw new NativeControllerError("conflict");
      if (requireNativeManagerMode(selection.mode) === "manual")
        manual.remove(bundleExecutable(selection.bundlePath));
    },
    withLegacyGuard(action) {
      return withServiceDefinitionGuard(legacy, true, action);
    },
  };
  return platform;
}
