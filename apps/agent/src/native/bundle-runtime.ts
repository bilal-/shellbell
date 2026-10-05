import { readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { boundedRead, optionalStat } from "../host-files.js";
import { runServiceCommand, type ServiceCommand } from "../service-command.js";
import { validateNativeBundleHelper } from "./platform.js";
import { NativeControllerError } from "./protocol.js";

const unsafe = (): never => {
  throw new NativeControllerError("unsafe-state");
};
export async function inspectBundleRuntime(
  bundlePath: string,
  options: { run?: ServiceCommand } = {},
) {
  try {
    if (
      realpathSync(bundlePath) !== bundlePath ||
      [...bundlePath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      unsafe();
    const run = options.run ?? runServiceCommand;
    const helper = await validateNativeBundleHelper(bundlePath, process.getuid!(), run);
    const contents = join(bundlePath, "Contents"),
      resources = join(contents, "Resources");
    const nodePath = join(contents, "Helpers/node"),
      controllerPath = join(resources, "agent/dist/native-controller.js"),
      servicePath = join(resources, "agent/dist/native-service.js");
    const files = [
      nodePath,
      controllerPath,
      servicePath,
      join(resources, "runtime/LICENSE"),
      join(resources, "agent/package.json"),
      join(resources, "agent/dist/cli.js"),
    ];
    const check = () => {
      for (const file of files) {
        for (let parent = dirname(file); parent !== bundlePath; parent = dirname(parent)) {
          const directory = optionalStat(parent);
          if (
            !directory?.isDirectory() ||
            directory.isSymbolicLink() ||
            (directory.mode & 0o7022) !== 0 ||
            (directory.uid !== 0 && directory.uid !== process.getuid!())
          )
            unsafe();
        }
        const st = optionalStat(file);
        if (
          !st?.isFile() ||
          st.isSymbolicLink() ||
          (st.mode & 0o7022) !== 0 ||
          (st.uid !== 0 && st.uid !== process.getuid!()) ||
          (file === nodePath && (st.mode & 0o111) === 0)
        )
          unsafe();
      }
      let count = 0;
      const seen = new Set<string>();
      const walk = (path: string): void => {
        if (++count > 100000) unsafe();
        const st = optionalStat(path);
        if (!st) throw new NativeControllerError("unsafe-state");
        const real = realpathSync(path);
        if (!real.startsWith(`${resources}/`)) unsafe();
        if (st.isSymbolicLink()) {
          walk(real);
          return;
        }
        if (seen.has(real)) return;
        seen.add(real);
        if ((st.uid !== 0 && st.uid !== process.getuid!()) || (st.mode & 0o7022) !== 0) unsafe();
        if (st.isDirectory()) {
          for (const name of readdirSync(path)) walk(join(path, name));
        } else if (!st.isFile()) unsafe();
      };
      for (const name of ["agent", "runtime"]) walk(join(resources, name));
    };
    check();
    const pkg = JSON.parse(
      boundedRead(join(resources, "agent/package.json"), 65536).toString("utf8"),
    );
    if (
      pkg.name !== "shellbell" ||
      typeof pkg.version !== "string" ||
      !pkg.version ||
      pkg.type !== "module"
    )
      unsafe();
    const require = createRequire(join(resources, "agent/package.json"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const target = realpathSync(require.resolve(name));
      if (!target.startsWith(`${resources}/agent/`)) unsafe();
    }
    const metadata = await run(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", join(contents, "Info.plist")],
      { timeoutMs: 10000, maxOutputBytes: 65536, captureOutput: true },
    );
    if (
      metadata.exitCode !== 0 ||
      JSON.parse(metadata.stdout.toString("utf8")).CFBundleShortVersionString !== pkg.version
    )
      unsafe();
    const node = await run(nodePath, ["--version"], {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      captureOutput: true,
    });
    if (node.exitCode !== 0 || node.stdout.toString("utf8").trim() !== "v22.23.1") unsafe();
    const architecture = await run(nodePath, ["-p", "process.platform + ':' + process.arch"], {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      captureOutput: true,
    });
    if (
      architecture.exitCode !== 0 ||
      architecture.stdout.toString("utf8").trim() !== `${process.platform}:${process.arch}`
    )
      unsafe();
    for (const script of [join(resources, "agent/dist/cli.js"), controllerPath, servicePath]) {
      const version = await run(nodePath, [script, "--version"], {
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        captureOutput: true,
      });
      if (version.exitCode !== 0 || version.stdout.toString("utf8").trim() !== pkg.version)
        unsafe();
    }
    helper.revalidate();
    check();
    return {
      executable: helper.executable,
      nodePath,
      controllerPath,
      servicePath,
      agentVersion: pkg.version as string,
    };
  } catch (error) {
    if (error instanceof NativeControllerError) throw error;
    return unsafe();
  }
}
