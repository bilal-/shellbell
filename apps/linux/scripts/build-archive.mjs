import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectLicenses,
  copyPayloadTree,
  run,
  verifyElf,
  verifyRuntimeArchive,
} from "./build-lib.mjs";
import { fail, runtimeManifest, sha256, verifyPayload, writeInventory } from "./payload.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, "../../..");
export async function buildArchive({ arch, runtimeArchive, output }) {
  if (!isAbsolute(runtimeArchive ?? "") || !isAbsolute(output ?? ""))
    fail("absolute-path-required");
  if (existsSync(output)) fail("output-exists");
  const runtime = await verifyRuntimeArchive(runtimeArchive, arch);
  // Never ship a bundle without its verified installation entrypoint.
  for (const file of [
    "install.mjs",
    "scripts/install-lib.mjs",
    "scripts/payload.mjs",
    "runtime-manifest.json",
  ]) {
    if (!existsSync(join(repo, "apps/linux", file))) fail("installation-engine-missing");
  }
  const clean = await run("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repo,
  });
  if (clean) fail("clean-source-required");
  const sourceCommit = await run("git", ["rev-parse", "HEAD"], { cwd: repo });
  const staging = mkdtempSync(join(tmpdir(), "shellbell-linux-build-"));
  console.log(`Disposable build staging: ${staging}`);
  const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
  await run("pnpm", ["-F", "shellbell", "build"], { cwd: repo, env });
  await run("pnpm", ["-F", "shellbell", "pack", "--pack-destination", staging], { cwd: repo, env });
  const packages = readdirSync(staging).filter((name) => name.endsWith(".tgz"));
  if (packages.length !== 1) fail("package-count");
  const prefix = join(staging, "dependencies");
  // npm metadata intentionally remains darwin-only. This builder assembles a
  // separate archive distribution; --force here is not end-user npm guidance.
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--force",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      join(staging, packages[0]),
    ],
    { env, timeout: 180000 },
  );
  const runtimeStage = join(staging, "node");
  mkdirSync(runtimeStage);
  // Only the exact pinned upstream archive reaches extraction.
  await run("tar", ["-xJf", runtimeArchive, "-C", runtimeStage]);
  const node = join(runtimeStage, runtime.directory, "bin/node");
  verifyElf(node, arch);
  const root = join(staging, "shellbell");
  mkdirSync(root, { mode: 0o755 });
  mkdirSync(join(root, "runtime"), { mode: 0o755 });
  mkdirSync(join(root, "runtime/bin"), { mode: 0o755 });
  writeFileSync(join(root, "runtime/bin/node"), readFileSync(node), { mode: 0o755, flag: "wx" });
  writeFileSync(
    join(root, "runtime/LICENSE"),
    readFileSync(join(runtimeStage, runtime.directory, "LICENSE")),
    { mode: 0o644, flag: "wx" },
  );
  const modules = join(prefix, "node_modules");
  copyPayloadTree(join(modules, "shellbell"), join(root, "agent"), modules);
  mkdirSync(join(root, "agent/node_modules"), { mode: 0o755 });
  for (const name of readdirSync(modules).sort()) {
    if (name === "shellbell" || name.startsWith(".")) continue;
    copyPayloadTree(join(modules, name), join(root, "agent/node_modules", name), modules);
  }
  mkdirSync(join(root, "scripts"), { mode: 0o755 });
  for (const name of [
    "install.mjs",
    "scripts/install-lib.mjs",
    "scripts/payload.mjs",
    "runtime-manifest.json",
  ]) {
    writeFileSync(join(root, name), readFileSync(join(repo, "apps/linux", name)), {
      flag: "wx",
      mode: 0o644,
    });
  }
  collectLicenses(join(root, "agent"), join(root, "licenses"), join(repo, "LICENSE"));
  await run(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      join(repo, "apps/macos/scripts/verify-imports.mjs"),
      join(root, "agent"),
    ],
    { env, timeout: 60000 },
  );
  const pkg = JSON.parse(readFileSync(join(root, "agent/package.json"), "utf8"));
  await writeInventory(root, {
    version: pkg.version,
    arch,
    sourceCommit,
    runtimeVersion: runtimeManifest.version,
    runtimeArchiveSha256: runtime.sha256,
  });
  await verifyPayload(root, { arch, sourceCommit });
  if (await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo }))
    fail("source-modified");
  mkdirSync(output, { mode: 0o755 });
  const name = `shellbell-${pkg.version}-linux-${arch}.tar.gz`;
  const archive = join(output, name);
  await run("tar", ["--format=ustar", "-czf", archive, "-C", staging, "shellbell"]);
  const checksum = sha256(readFileSync(archive));
  writeFileSync(`${archive}.sha256`, `${checksum}  ${name}\n`, { flag: "wx", mode: 0o644 });
  return { archive, sha256: checksum, arch, version: pkg.version, sourceCommit, staging };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  const names = { "--arch": "arch", "--runtime-archive": "runtimeArchive", "--output": "output" };
  try {
    while (args.length) {
      const flag = args.shift();
      if (!names[flag] || !args.length || options[names[flag]] !== undefined)
        fail("usage: --arch x64|arm64 --runtime-archive ABS --output ABS_NEW_DIR");
      options[names[flag]] = args.shift();
    }
    console.log(JSON.stringify(await buildArchive(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
