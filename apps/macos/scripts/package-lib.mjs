import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const manifest = JSON.parse(
  readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"),
);
const entries = ["cli.js", "native-controller.js", "native-service.js"];
const marketingVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const inventoryName = "Contents/Resources/build-inventory.json";
export const powerHelperPath = "Contents/Library/HelperTools/ShellbellPowerHelper";
export const powerDaemonPath = "Contents/Library/LaunchDaemons/sh.bilal.shellbell.power.plist";
const powerDaemonExpected = {
  Label: "sh.bilal.shellbell.power",
  BundleProgram: powerHelperPath,
  ProgramArguments: ["ShellbellPowerHelper"],
  UserName: "root",
  MachServices: { "sh.bilal.shellbell.power": true },
  RunAtLoad: true,
  KeepAlive: true,
  ProcessType: "Background",
  ThrottleInterval: 10,
  ExitTimeOut: 20,
};
export function copyTree(source, destination) {
  const modes = [];
  walk(source, (path, st) => {
    if (!st.isSymbolicLink()) modes.push([relative(source, path), st.mode & 0o777]);
  });
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
  // cpSync applies the process umask to new files. Restore admitted source modes
  // so a restrictive release shell cannot change the bundle's exact inventory.
  for (const [path, mode] of modes) chmodSync(join(destination, path), mode);
}
const agentBuildMetadata = [
  "node_modules/.modules.yaml",
  "node_modules/.pnpm-workspace-state-v1.json",
];
export function pruneAgentBuildMetadata(agent) {
  for (const name of agentBuildMetadata) {
    const path = join(agent, name);
    if (!existsSync(path)) continue;
    regular(path);
    unlinkSync(path);
  }
}
export function loadSupplement(source, pkg) {
  const base = join(source, "apps/macos/Resources/DependencyLicenses");
  const index = JSON.parse(readFileSync(join(base, "index.json"), "utf8"));
  const record = index[`${pkg.name}@${pkg.version}`];
  if (!record || record.license !== pkg.license || !record.files?.length)
    fail("missing-licenses", `${pkg.name}@${pkg.version}`);
  return record.files.map((item) => {
    const path = join(base, item.name);
    contained(base, path);
    regular(path);
    if (!item.source?.startsWith("https://") || digest(readFileSync(path)) !== item.sha256)
      fail("license-integrity", item.name);
    return { path, source: item.source, sha256: item.sha256 };
  });
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, detail = code) => {
  throw Object.assign(new Error(detail), { code });
};
export async function run(file, args, options = {}) {
  const { logFile, ...execOptions } = options;
  const timeout = execOptions.timeout ?? 600000;
  const maxBuffer = execOptions.maxBuffer ?? 8 * 1024 * 1024;
  const started = Date.now();
  const bounded = (value, limit = 8192) =>
    Buffer.from(String(value ?? ""))
      .subarray(0, limit)
      .toString("utf8");
  const record = (result, failure) => {
    if (!logFile) return;
    appendFileSync(
      logFile,
      `${JSON.stringify({
        file: bounded(file, 4096),
        args: args.slice(0, 32).map((arg) => bounded(arg, 512)),
        cwd: options.cwd === undefined ? undefined : bounded(options.cwd, 4096),
        stdout: bounded(result.stdout),
        stderr: bounded(result.stderr),
        ...(failure
          ? {
              failure: {
                code:
                  failure.code == null
                    ? null
                    : typeof failure.code === "number"
                      ? failure.code
                      : bounded(failure.code, 128),
                signal: failure.signal == null ? null : bounded(failure.signal, 128),
                killed: failure.killed === true,
                timeoutMs: timeout,
                timedOut: failure.killed === true && timeout > 0 && Date.now() - started >= timeout,
                maxBuffer,
                outputLimit: failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              },
            }
          : {}),
      })}\n`,
    );
  };
  let result;
  try {
    result = await exec(file, args, { timeout, maxBuffer, ...execOptions, shell: false });
  } catch (failure) {
    // Evidence is best effort on failure; never replace the original rejection
    // with a logging error or turn a failed command into success.
    try {
      record(failure, failure);
    } catch {}
    throw failure;
  }
  record(result);
  return result.stdout.trim();
}
function absolute(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    Buffer.byteLength(path) > 4096 ||
    resolve(path) !== path
  )
    fail("unsafe-path");
  return path;
}
export function requireNewPath(path) {
  absolute(path);
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      if (!lstatSync(realpathSync(dirname(path))).isDirectory()) fail("unsafe-path");
      return;
    }
    throw error;
  }
  fail("output-exists", `Refusing existing output: ${path}`);
}
function regular(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) fail("unsafe-file", path);
  return st;
}
function archSpec(arch) {
  if (!Object.hasOwn(manifest.archives, arch)) fail("runtime-architecture");
  return manifest.archives[arch];
}
export function validateBuildNumber(value) {
  // Project-wide candidate counters use the same bounded integer format on all
  // native platforms. This cap is a Shellbell policy for macOS, not an Apple limit.
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || Number(value) > 2100000000)
    fail("build-number", "Supply a positive integer build number at most 2100000000.");
  return value;
}
export async function setBundleVersion(app, version, buildNumber, options = {}) {
  if (typeof version !== "string" || !marketingVersionPattern.test(version))
    fail("package-metadata");
  validateBuildNumber(buildNumber);
  const command = options.run ?? run;
  const plist = join(app, "Contents/Info.plist");
  await command("/usr/bin/plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    version,
    plist,
  ]);
  await command("/usr/bin/plutil", ["-replace", "CFBundleVersion", "-string", buildNumber, plist]);
}
export function parseBuildArgs(args) {
  const result = {};
  const keys = {
    "--arch": "arch",
    "--output": "output",
    "--runtime-archive": "archive",
    "--build-number": "buildNumber",
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || result[key] || !args[i + 1])
      fail(
        "arguments",
        "Usage: build.mjs --arch arm64|x64 --output ABSOLUTE_NEW_DIRECTORY --runtime-archive ABSOLUTE_PATH --build-number POSITIVE_INTEGER",
      );
    result[key] = args[i + 1];
  }
  archSpec(result.arch);
  absolute(result.output);
  absolute(result.archive);
  validateBuildNumber(result.buildNumber);
  return result;
}
export function admitArchiveListing(names, selected, arch) {
  const prefix = archSpec(arch).directory;
  const list = names.trim().split("\n");
  for (const name of list) {
    if (
      !name.startsWith(`${prefix}/`) ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      fail("runtime-archive-layout");
  }
  for (const name of [`${prefix}/bin/node`, `${prefix}/LICENSE`])
    if (list.filter((x) => x === name).length !== 1) fail("runtime-archive-layout");
  const details = selected.trim().split("\n");
  if (details.length !== 2 || details.some((line) => !line.startsWith("-")))
    fail("runtime-archive-layout");
}
export async function verifyArchive(path, arch, options = {}) {
  absolute(path);
  const spec = archSpec(arch);
  const st = regular(path);
  if (st.size > 100000000 || digest(readFileSync(path)) !== spec.sha256) fail("runtime-integrity");
  const command = options.run ?? run;
  const names = await command("/usr/bin/tar", ["-tf", path], { timeout: 60000 });
  const selected = await command(
    "/usr/bin/tar",
    ["-tvf", path, `${spec.directory}/bin/node`, `${spec.directory}/LICENSE`],
    { timeout: 60000 },
  );
  admitArchiveListing(names, selected, arch);
  return spec;
}
export async function snapshotSource(sourceRoot, staging, command = run) {
  if (
    await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot })
  )
    fail("dirty-source", "Commit source changes before building a distribution snapshot.");
  const commit = await command("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("source-commit");
  const source = join(staging, "source");
  mkdirSync(source);
  const archive = join(staging, "source.tar");
  await command("git", ["archive", "--format=tar", `--output=${archive}`, commit], {
    cwd: sourceRoot,
  });
  await command("/usr/bin/tar", ["-xf", archive, "-C", source]);
  return { source, commit };
}
function contained(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("bundle-escape", path);
}
function walk(root, visit) {
  let count = 0;
  const scan = (path) => {
    if (++count > 100000) fail("tree-limit");
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      contained(root, path);
      visit(path, st);
      return;
    }
    if (!st.isFile() && !st.isDirectory()) fail("special-file", path);
    if ((st.mode & 0o7022) !== 0) fail("unsafe-mode", path);
    visit(path, st);
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) scan(join(path, name));
  };
  scan(root);
}
export function fileInventory(app) {
  const result = {};
  walk(app, (path, st) => {
    const name = relative(app, path);
    if (name === inventoryName || st.isDirectory()) return;
    result[name] = st.isSymbolicLink()
      ? { link: readlinkSync(path) }
      : { sha256: digest(readFileSync(path)), mode: st.mode & 0o777 };
  });
  return result;
}
export async function writeInventory(app, metadata) {
  validateBuildNumber(metadata.buildNumber);
  const inventory = {
    ...metadata,
    runtimeVersion: manifest.version,
    developmentOnly: true,
    files: fileInventory(app),
  };
  writeFileSync(join(app, inventoryName), `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return inventory;
}
async function verifyImports(agent, arch, signedAddonSha256) {
  // Use Node's ESM resolver with its explicit parent URL plus the CJS resolver,
  // in a bounded trusted analysis process; no packaged dependency is evaluated.
  await run(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      fileURLToPath(new URL("./verify-imports.mjs", import.meta.url)),
      agent,
      arch,
      ...(signedAddonSha256 === undefined ? [] : [signedAddonSha256]),
    ],
    {
      timeout: 60000,
      maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin" },
    },
  );
}
export async function inspectBundle(app, options = {}) {
  absolute(app);
  if (!lstatSync(app).isDirectory() || lstatSync(app).isSymbolicLink()) fail("bundle-root");
  walk(app, () => {});
  const contents = join(app, "Contents"),
    resources = join(contents, "Resources"),
    agent = join(resources, "agent");
  for (const file of [
    "Info.plist",
    "MacOS/Shellbell",
    "Library/LaunchAgents/sh.bilal.shellbell.host.agent.plist",
    "Library/HelperTools/ShellbellPowerHelper",
    "Library/LaunchDaemons/sh.bilal.shellbell.power.plist",
    "Resources/ShellbellService.icns",
    "Resources/ShellbellTemplate.png",
    "Resources/ShellbellTemplate@2x.png",
    "Helpers/node",
    "Resources/runtime/LICENSE",
    "Resources/agent/package.json",
    "Resources/licenses/Shellbell-LICENSE",
    "Resources/licenses/index.json",
    ...entries.map((x) => `Resources/agent/dist/${x}`),
  ])
    regular(join(contents, file));
  const command = options.run ?? run;
  const info = JSON.parse(
    await command(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", join(contents, "Info.plist")],
      { timeout: 10000 },
    ),
  );
  for (const name of agentBuildMetadata) {
    if (existsSync(join(agent, name))) fail("build-tool-metadata");
  }
  const pkg = JSON.parse(readFileSync(join(agent, "package.json"), "utf8"));
  const expected = {
    CFBundleIdentifier: "sh.bilal.shellbell.host",
    CFBundleExecutable: "Shellbell",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: pkg.version,
    CFBundleIconFile: "ShellbellService",
    LSMinimumSystemVersion: "13.0",
    LSUIElement: true,
  };
  if (
    pkg.name !== "shellbell" ||
    pkg.type !== "module" ||
    !marketingVersionPattern.test(pkg.version)
  )
    fail("package-metadata");
  const buildNumber = validateBuildNumber(info.CFBundleVersion);
  for (const [key, value] of Object.entries(expected))
    if (info[key] !== value) fail("bundle-metadata", key);
  const launch = JSON.parse(
    await command(
      "/usr/bin/plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        join(contents, "Library/LaunchAgents/sh.bilal.shellbell.host.agent.plist"),
      ],
      { timeout: 10000 },
    ),
  );
  const launchExpected = {
    Label: "sh.bilal.shellbell.host.agent",
    BundleProgram: "Contents/MacOS/Shellbell",
    ProgramArguments: ["Shellbell", "--service-run", "persistent"],
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    ThrottleInterval: 10,
  };
  if (Object.keys(launch).length !== Object.keys(launchExpected).length) fail("launch-metadata");
  for (const [key, value] of Object.entries(launchExpected))
    if (JSON.stringify(launch[key]) !== JSON.stringify(value)) fail("launch-metadata", key);
  let arch = options.arch;
  const powerDaemon = JSON.parse(
    await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, powerDaemonPath)], {
      timeout: 10000,
    }),
  );
  if (Object.keys(powerDaemon).length !== Object.keys(powerDaemonExpected).length)
    fail("power-launch-metadata");
  for (const [key, value] of Object.entries(powerDaemonExpected))
    if (JSON.stringify(powerDaemon[key]) !== JSON.stringify(value))
      fail("power-launch-metadata", key);
  for (const file of [
    join(contents, "MacOS/Shellbell"),
    join(contents, "Helpers/node"),
    join(app, powerHelperPath),
  ]) {
    if (!(regular(file).mode & 0o111)) fail("not-executable");
    const detected = (await command("/usr/bin/lipo", ["-archs", file], { timeout: 10000 })).trim();
    const target = detected === "x86_64" ? "x64" : detected;
    arch ??= target;
    if (target !== arch) fail("runtime-architecture");
    archSpec(arch);
  }
  await verifyImports(agent, arch, options.signedAddonSha256);
  const notices = JSON.parse(readFileSync(join(resources, "licenses/index.json"), "utf8"));
  if (!Array.isArray(notices) || !notices.length) fail("missing-licenses");
  for (const item of notices) {
    if (!item.name || !item.version || !Array.isArray(item.files) || !item.files.length)
      fail("missing-licenses");
    for (const name of item.files) {
      const p = join(resources, "licenses", name);
      contained(join(resources, "licenses"), p);
      regular(p);
    }
  }
  for (const name of Object.keys(pkg.dependencies ?? {}))
    if (!notices.some((item) => item.name === name)) fail("missing-licenses", name);
  return { arch, version: pkg.version, buildNumber };
}
export async function verifyBundle(app, options = {}) {
  const { arch, version: appVersion, buildNumber } = await inspectBundle(app, options);
  const command = options.run ?? run;
  const contents = join(app, "Contents");
  if (options.inventory !== false) {
    regular(join(app, inventoryName));
    const inventory = JSON.parse(readFileSync(join(app, inventoryName), "utf8"));
    if (
      inventory.arch !== arch ||
      inventory.buildNumber !== buildNumber ||
      inventory.runtimeVersion !== manifest.version ||
      inventory.runtimeArchiveSha256 !== archSpec(arch).sha256 ||
      !/^[0-9a-f]{40}$/.test(inventory.sourceCommit) ||
      !inventory.developmentOnly ||
      JSON.stringify(inventory.files) !== JSON.stringify(fileInventory(app))
    )
      fail("bundle-integrity");
  }
  // Only this version-only invocation is allowed after complete static admission.
  // A cross-architecture binary must already be executable by this host; no fallback.
  const isolation = mkdtempSync(join(tmpdir(), "shellbell-native-version-"));
  try {
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: isolation,
      SHELLBELL_DIR: join(isolation, "state"),
      XDG_STATE_HOME: join(isolation, "xdg-state"),
      XDG_RUNTIME_DIR: join(isolation, "runtime"),
    };
    let version;
    try {
      version = await command(join(contents, "Helpers/node"), ["--version"], {
        env,
        cwd: isolation,
        timeout: 5000,
        maxBuffer: 65536,
      });
    } catch {
      fail(
        "runtime-version-unavailable",
        "Host cannot complete the isolated runtime version check; use an already-capable/native verification host.",
      );
    }
    if (readdirSync(isolation).length !== 0) fail("version-state-created");
    if (version !== `v${manifest.version}`) fail("runtime-version");
  } finally {
    // Remove only our own empty version probe directory; preserve unexpected state.
    if (readdirSync(isolation).length === 0) rmdirSync(isolation);
  }
  return { arch, version: appVersion, buildNumber, files: Object.keys(fileInventory(app)).length };
}
function collectLicenses(source, agent, destination) {
  mkdirSync(destination);
  copyFileSync(join(source, "LICENSE"), join(destination, "Shellbell-LICENSE"));
  const packages = new Map();
  walk(join(agent, "node_modules"), (path, st) => {
    if (st.isFile() && path.endsWith("/package.json")) {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      if (pkg.name && pkg.version)
        packages.set(`${pkg.name}@${pkg.version}`, { path: dirname(path), pkg });
    }
  });
  for (const name of ["@noble/ciphers", "@noble/curves", "@noble/hashes", "cborg"]) {
    const path = join(source, "node_modules", name),
      pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    packages.set(`${name}@${pkg.version}`, { path, pkg });
  }
  const index = [];
  for (const [key, { path, pkg }] of [...packages].sort()) {
    const licenses = readdirSync(path).filter((name) =>
      /^(license|licence|copying|notice)(\.|$)/i.test(name),
    );
    const supplement = licenses.length ? [] : loadSupplement(source, pkg);
    const files = licenses.map((name) => {
      regular(join(path, name));
      const file = `${key.replaceAll("/", "_")}-${name}`;
      copyFileSync(join(path, name), join(destination, file));
      return file;
    });
    for (const item of supplement) {
      const file = `${key.replaceAll("/", "_")}-${relative(join(source, "apps/macos/Resources/DependencyLicenses"), item.path)}`;
      copyFileSync(item.path, join(destination, file));
      files.push(file);
    }
    index.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      files,
      ...(supplement.length
        ? { sources: supplement.map(({ source, sha256 }) => ({ source, sha256 })) }
        : {}),
    });
  }
  writeFileSync(join(destination, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}
export function sourceMetadata(source) {
  const hash = createHash("sha256");
  let count = 0;
  const scan = (path) => {
    const st = lstatSync(path);
    count++;
    hash.update(
      JSON.stringify([
        relative(source, path),
        st.mode,
        st.ino,
        st.size,
        st.mtimeMs,
        st.isSymbolicLink() ? readlinkSync(path) : null,
      ]),
    );
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) scan(join(path, name));
  };
  for (const name of ["node_modules", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    if (existsSync(join(source, name))) scan(join(source, name));
  return { digest: hash.digest("hex"), entries: count };
}
export async function smokeBundle(app, command = run) {
  const admitted = await verifyBundle(app, { run: command });
  const isolation = mkdtempSync(join(tmpdir(), "shellbell-native-smoke-"));
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: isolation,
    SHELLBELL_DIR: join(isolation, "state"),
    XDG_STATE_HOME: join(isolation, "xdg-state"),
    XDG_RUNTIME_DIR: join(isolation, "runtime"),
  };
  const node = join(app, "Contents/Helpers/node");
  for (const entry of entries)
    for (const flag of ["--version", "--help"]) {
      const output = await command(
        node,
        [join(app, "Contents/Resources/agent/dist", entry), flag],
        { env, cwd: isolation, timeout: 5000, maxBuffer: 65536 },
      );
      if (flag === "--version" ? output !== admitted.version : !output.trim())
        fail("smoke-output", entry);
    }
  if (readdirSync(isolation).length !== 0) fail("smoke-state-created");
  return { isolation, ...admitted };
}
export async function build(options) {
  const { arch, output, archive, buildNumber } = options;
  validateBuildNumber(buildNumber);
  archSpec(arch);
  requireNewPath(output);
  await verifyArchive(archive, arch);
  const before = sourceMetadata(repoRoot),
    staging = mkdtempSync(join(tmpdir(), "shellbell-native-build-"));
  console.log(`Disposable build source/staging: ${staging}`);
  const command = (file, args, opts = {}) =>
    run(file, args, { ...opts, logFile: join(staging, "commands.jsonl") });
  writeFileSync(join(staging, "source-preservation-before.json"), JSON.stringify(before));
  try {
    const { source, commit } = await snapshotSource(repoRoot, staging, command);
    const verifiedArchive = join(staging, "runtime.tar.xz");
    copyFileSync(archive, verifiedArchive);
    const spec = await verifyArchive(verifiedArchive, arch, { run: command });
    await command(
      "pnpm",
      ["--filter", "shellbell...", "install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: source, env: { ...process.env, CI: "true" } },
    );
    await command("pnpm", ["-F", "shellbell", "build"], { cwd: source });
    const deployed = join(staging, "agent");
    await command(
      "pnpm",
      [
        "--filter",
        "shellbell",
        "deploy",
        "--legacy",
        "--prod",
        "--offline",
        "--ignore-scripts",
        deployed,
      ],
      { cwd: source, env: { ...process.env, CI: "true" } },
    );
    const swiftArgs = [
      "build",
      "--package-path",
      join(source, "apps/macos"),
      "--configuration",
      "release",
      "--arch",
      arch === "x64" ? "x86_64" : "arm64",
    ];
    await command("swift", swiftArgs, { cwd: source });
    const binPath = await command("swift", [...swiftArgs, "--show-bin-path"], { cwd: source });
    contained(source, binPath);
    mkdirSync(output);
    const app = join(output, "Shellbell.app"),
      contents = join(app, "Contents"),
      resources = join(contents, "Resources");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Library/LaunchAgents"), { recursive: true });
    mkdirSync(join(contents, "Library/HelperTools"), { recursive: true });
    mkdirSync(join(contents, "Library/LaunchDaemons"), { recursive: true });
    mkdirSync(resources);
    copyFileSync(join(binPath, "Shellbell"), join(contents, "MacOS/Shellbell"));
    chmodSync(join(contents, "MacOS/Shellbell"), 0o755);
    copyFileSync(join(binPath, "ShellbellPowerHelper"), join(app, powerHelperPath));
    chmodSync(join(app, powerHelperPath), 0o755);
    copyFileSync(
      join(source, "apps/macos/Resources/sh.bilal.shellbell.power.plist"),
      join(app, powerDaemonPath),
    );
    copyFileSync(join(source, "apps/macos/Resources/Info.plist"), join(contents, "Info.plist"));
    copyFileSync(
      join(source, "apps/macos/Resources/sh.bilal.shellbell.host.agent.plist"),
      join(contents, "Library/LaunchAgents/sh.bilal.shellbell.host.agent.plist"),
    );
    copyFileSync(
      join(source, "brand/macos/shellbell-service.icns"),
      join(resources, "ShellbellService.icns"),
    );
    for (const name of ["ShellbellTemplate.png", "ShellbellTemplate@2x.png"])
      copyFileSync(join(source, "brand/macos/menu-bar/18", name), join(resources, name));
    const extracted = join(staging, "runtime");
    mkdirSync(extracted);
    await command(
      "/usr/bin/tar",
      [
        "-xf",
        verifiedArchive,
        "-C",
        extracted,
        `${spec.directory}/bin/node`,
        `${spec.directory}/LICENSE`,
      ],
      { timeout: 60000 },
    );
    mkdirSync(join(contents, "Helpers"));
    copyFileSync(join(extracted, spec.directory, "bin/node"), join(contents, "Helpers/node"));
    mkdirSync(join(resources, "runtime"));
    copyFileSync(join(extracted, spec.directory, "LICENSE"), join(resources, "runtime/LICENSE"));
    copyTree(deployed, join(resources, "agent"));
    pruneAgentBuildMetadata(join(resources, "agent"));
    const { version } = JSON.parse(readFileSync(join(deployed, "package.json"), "utf8"));
    await setBundleVersion(app, version, buildNumber, { run: command });
    collectLicenses(source, join(resources, "agent"), join(resources, "licenses"));
    await writeInventory(app, {
      arch,
      buildNumber,
      sourceCommit: commit,
      runtimeArchiveSha256: spec.sha256,
    });
    const verification = await smokeBundle(app, command),
      after = sourceMetadata(repoRoot);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("source-modified");
    const evidence = {
      sourceCommit: commit,
      version,
      buildNumber,
      source,
      staging,
      archive: realpathSync(archive),
      output,
      app,
      before,
      after,
      verification,
      developmentOnly: true,
    };
    writeFileSync(join(output, "build-report.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    writeFileSync(
      join(staging, "source-preservation-after.json"),
      JSON.stringify(sourceMetadata(repoRoot)),
    );
    if (JSON.stringify(before) !== JSON.stringify(sourceMetadata(repoRoot)))
      fail("source-modified", `Source metadata changed; preserved staging at ${staging}`);
  }
}
export async function makeDmg(app, output, options = {}) {
  absolute(app);
  requireNewPath(output);
  if (!output.endsWith(".dmg")) fail("dmg-extension");
  const command = options.run ?? run;
  await verifyBundle(app, { run: command });
  const staging = mkdtempSync(join(tmpdir(), "shellbell-native-dmg-")),
    volume = join(staging, "volume");
  mkdirSync(volume);
  copyTree(app, join(volume, "Shellbell.app"));
  symlinkSync("/Applications", join(volume, "Applications"));
  writeFileSync(
    join(volume, "READ-ME.txt"),
    "Shellbell development build (unsigned/ad-hoc; not notarized).\nCopy Shellbell.app to Applications yourself. Opening it does not enable future-login service without explicit consent.\nTo remove: explicitly stop/disable the service in Shellbell first, quit the UI, then remove the app. Preserve your keys/configuration unless you separately choose to delete them.\n",
  );
  await command(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      "Shellbell",
      "-srcfolder",
      volume,
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      output,
    ],
    { timeout: 120000 },
  );
  await command("/usr/bin/hdiutil", ["verify", output], { timeout: 120000 });
  return { output, staging, sha256: digest(readFileSync(output)) };
}
